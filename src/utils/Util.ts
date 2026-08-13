import {
    ActivityType,
    ButtonBuilder,
    ButtonStyle,
    ChannelType,
    ContainerBuilder,
    codeBlock,
    DiscordAPIError,
    EmbedBuilder,
    type Message,
    MessageFlags,
    SeparatorSpacingSize,
    type TextChannel,
    TextDisplayBuilder,
} from 'discord.js';
import type { Client } from 'discordx';
import '@colors/colors';
import KeyvSqlite from '@keyv/sqlite';
import axios from 'axios';
import Keyv from 'keyv';
import WebSocket from 'ws';
import { config } from '../config/Config.js';

// API Response Types
interface Nuke {
    id: number;
    net: string;
    nukeAt: number;
    preId: number;
    reason: string;
    type: string;
    typeId: number;
}

interface Release {
    cat: string;
    files: number;
    genre: string;
    id: number;
    name: string;
    nuke: Nuke | null;
    preAt: number;
    size: number;
    team: string;
    url: string;
}

interface WebSocketMessage {
    action: 'insert' | 'update' | 'delete' | 'nuke' | 'unnuke' | 'modnuke' | 'delpre' | 'undelpre';
    row: Release;
}

export const keyv = new Keyv({
    namespace: 'data',
    store: new KeyvSqlite({ uri: 'sqlite://src/data/db.sqlite' }),
});
keyv.on('error', (err) => console.log('[keyv] Connection Error', err));

// ---------------------------
// Last-seen tracking helpers
// ---------------------------
interface LastSeen {
    id?: number;
    preAt?: number;
}

function normalizeQueryStorageKey(query: string): string {
    return query.toLowerCase().replace(/\s+/g, '+').trim();
}

function getLastSeenKey(guildId: string, query: string): string {
    const normalized = normalizeQueryStorageKey(query);
    return `lastSeen:${guildId}:${normalized}`;
}

const lastSeenCache = new Map<string, LastSeen>();

export async function getLastSeenForGuildQuery(guildId: string, query: string): Promise<LastSeen> {
    const key = getLastSeenKey(guildId, query);
    const cached = lastSeenCache.get(key);
    if (cached) {
        return cached;
    }
    const value = ((await keyv.get(key)) as LastSeen | undefined) || {};
    lastSeenCache.set(key, value);
    return value;
}

export async function setLastSeenForGuildQuery(
    guildId: string,
    query: string,
    release: Release
): Promise<void> {
    const key = getLastSeenKey(guildId, query);
    const payload: LastSeen = { id: release.id, preAt: release.preAt };
    lastSeenCache.set(key, payload);
    await keyv.set(key, payload);
}

/**
 * Records a watermark for a new watch so poll/catch-up will not dump history.
 */
export async function seedLastSeenIfAbsent(
    guildId: string,
    query: string,
    preAt: number
): Promise<void> {
    const existing = await getLastSeenForGuildQuery(guildId, query);
    if (typeof existing.preAt === 'number') {
        return;
    }
    const key = getLastSeenKey(guildId, query);
    const payload: LastSeen = { preAt };
    lastSeenCache.set(key, payload);
    await keyv.set(key, payload);
}

// Serialize lastSeen check → send → ack per guild+query so overlapping
// WebSocket/poll inserts cannot both pass the watermark and double-notify.
const lastSeenLocks = new Map<string, Promise<void>>();

function withLastSeenLock<T>(guildId: string, query: string, fn: () => Promise<T>): Promise<T> {
    const key = getLastSeenKey(guildId, query);
    const previous = lastSeenLocks.get(key) ?? Promise.resolve();
    const run = previous.then(fn);
    lastSeenLocks.set(
        key,
        run.then(
            () => undefined,
            () => undefined
        )
    );
    return run;
}

function isAlreadySeen(lastSeen: LastSeen, release: Release): boolean {
    if (typeof lastSeen.id === 'number' && lastSeen.id === release.id) {
        return true;
    }
    return typeof lastSeen.preAt === 'number' && release.preAt <= lastSeen.preAt;
}

const NOTIFY_SEND_ATTEMPTS = 3;
const NOTIFY_RETRY_DELAY_MS = 1000;

function isNonRetryableSendError(error: unknown): boolean {
    if (!(error instanceof DiscordAPIError)) {
        return false;
    }
    return (
        error.status === 400 || error.status === 401 || error.status === 403 || error.status === 404
    );
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

// ---------------------------
// Scene-aware query matching (shared by WebSocket and poll)
// ---------------------------
const QUERY_STOPWORDS = new Set(['a', 'an', 'and', 'of', 'or', 'the', 'to']);

export interface ParsedWatchQuery {
    cat?: string;
    exact: string[][];
    team?: string;
    tokens: string[];
}

/**
 * Splits a scene fragment on dots, dashes, underscores, and spaces.
 * WEB-DL → [web, dl]. S01E01 and 1080p stay whole tokens.
 */
export function tokenizeSceneFragment(fragment: string): string[] {
    return fragment
        .toLowerCase()
        .split(/[.\s_\-/]+/)
        .map((token) => token.replace(/[^a-z0-9]/g, ''))
        .filter((token) => token.length > 0);
}

function stripSceneGroup(name: string, team: string): string {
    const lower = name.toLowerCase();
    if (team && lower.endsWith(`-${team}`)) {
        return name.slice(0, -(team.length + 1));
    }
    const groupMatch = lower.match(/-([a-z0-9]+)$/);
    if (groupMatch) {
        return name.slice(0, -groupMatch[0].length);
    }
    return name;
}

function tokenizeRelease(release: Release): { cat: string; team: string; tokens: string[] } {
    const team = (release.team || '').toLowerCase();
    const nameTokens = tokenizeSceneFragment(stripSceneGroup(release.name, team));
    if (team) {
        nameTokens.push(team);
    }
    return {
        cat: (release.cat || '').toLowerCase(),
        team,
        tokens: nameTokens,
    };
}

function hasConsecutiveTokens(haystack: string[], needle: string[]): boolean {
    if (needle.length === 0) {
        return true;
    }
    const lastStart = haystack.length - needle.length;
    if (lastStart < 0) {
        return false;
    }
    return haystack
        .slice(0, lastStart + 1)
        .some((_, start) => needle.every((token, offset) => haystack[start + offset] === token));
}

/**
 * Parses a user watch query into tokens plus optional team/cat/quoted filters.
 * Examples: `breaking bad 1080p`, `team:SPARKS`, `cat:X264 "breaking bad"`
 */
export function parseWatchQuery(raw: string): ParsedWatchQuery {
    const exact: string[][] = [];
    const withoutQuotes = raw.replace(/"([^"]+)"/g, (_match, phrase: string) => {
        const phraseTokens = tokenizeSceneFragment(phrase);
        if (phraseTokens.length > 0) {
            exact.push(phraseTokens);
        }
        return ' ';
    });

    const tokens: string[] = [];
    let team: string | undefined;
    let cat: string | undefined;

    for (const part of withoutQuotes.split(/\s+/).filter(Boolean)) {
        const filter = part.match(/^(team|group|cat|category):(.+)$/i);
        if (filter) {
            const key = filter[1]!.toLowerCase();
            const value = filter[2]!.toLowerCase();
            if (!value) {
                continue;
            }
            if (key === 'team' || key === 'group') {
                team = value.replace(/^-+/, '');
            } else {
                cat = value;
            }
            continue;
        }
        if (/^-[a-z0-9]{2,}$/i.test(part)) {
            team = part.slice(1).toLowerCase();
            continue;
        }
        for (const token of tokenizeSceneFragment(part)) {
            if (!QUERY_STOPWORDS.has(token)) {
                tokens.push(token);
            }
        }
    }

    return { cat, exact, team, tokens };
}

export function isWatchQueryUsable(parsed: ParsedWatchQuery): boolean {
    return (
        parsed.tokens.length > 0 ||
        parsed.exact.length > 0 ||
        Boolean(parsed.team) ||
        Boolean(parsed.cat)
    );
}

export function releaseMatchesParsed(parsed: ParsedWatchQuery, release: Release): boolean {
    if (!isWatchQueryUsable(parsed)) {
        return false;
    }

    const scene = tokenizeRelease(release);
    const tokenSet = new Set(scene.tokens);

    if (parsed.team && scene.team !== parsed.team) {
        return false;
    }
    if (parsed.cat && !scene.cat.includes(parsed.cat)) {
        return false;
    }
    if (!parsed.tokens.every((token) => tokenSet.has(token))) {
        return false;
    }
    return parsed.exact.every((phrase) => hasConsecutiveTokens(scene.tokens, phrase));
}

export function releaseMatchesQuery(query: string, release: Release): boolean {
    return releaseMatchesParsed(parseWatchQuery(query), release);
}

/**
 * PreDB search string for poll catch-up. Filters like team: are stripped so
 * the API is only used to fetch candidates; local matching is the authority.
 */
export function pollSearchString(query: string): string {
    const parsed = parseWatchQuery(query);
    const [quoted] = parsed.exact;
    if (quoted && quoted.length > 0) {
        return quoted.join(' ');
    }
    if (parsed.tokens.length > 0) {
        return parsed.tokens.join(' ');
    }
    return parsed.team || parsed.cat || query;
}

export function areWatchQueriesSimilar(left: string, right: string): boolean {
    const parsedLeft = parseWatchQuery(left);
    const parsedRight = parseWatchQuery(right);
    if (parsedLeft.team && parsedRight.team && parsedLeft.team !== parsedRight.team) {
        return false;
    }
    if (parsedLeft.cat && parsedRight.cat && parsedLeft.cat !== parsedRight.cat) {
        return false;
    }

    const tokensLeft = new Set([...parsedLeft.tokens, ...parsedLeft.exact.flat()]);
    const tokensRight = new Set([...parsedRight.tokens, ...parsedRight.exact.flat()]);
    if (tokensLeft.size === 0 || tokensRight.size === 0) {
        return Boolean(
            (parsedLeft.team && parsedLeft.team === parsedRight.team) ||
                (parsedLeft.cat && parsedLeft.cat === parsedRight.cat)
        );
    }

    const smaller = Math.min(tokensLeft.size, tokensRight.size);
    let common = 0;
    for (const token of tokensLeft) {
        if (tokensRight.has(token)) {
            common += 1;
        }
    }
    return common / smaller >= 0.6;
}

// ---------------------------
// Per-guild alerts channel (for channel notification mode)
// ---------------------------
const ALERTS_CHANNEL_KEY_PREFIX = 'alertsChannel:';

interface IndexedQuery {
    parsed: ParsedWatchQuery;
    query: string;
    users: Set<string>;
}

interface IndexedGuild {
    channelId?: string;
    queries: Map<string, IndexedQuery>;
}

interface ActiveSubscription {
    channelId: string;
    guildId: string;
    parsed: ParsedWatchQuery;
    query: string;
    users: string[];
}

const subscriptionIndex = new Map<string, IndexedGuild>();
const alertsChannelByGuild = new Map<string, string>();
let indexHydrated = false;

function getOrCreateIndexedGuild(guildId: string): IndexedGuild {
    let guild = subscriptionIndex.get(guildId);
    if (!guild) {
        guild = {
            channelId: alertsChannelByGuild.get(guildId),
            queries: new Map(),
        };
        subscriptionIndex.set(guildId, guild);
    }
    return guild;
}

function indexAddUser(guildId: string, query: string, userId: string): void {
    const guild = getOrCreateIndexedGuild(guildId);
    const key = normalizeQueryStorageKey(query);
    let entry = guild.queries.get(key);
    if (!entry) {
        entry = { parsed: parseWatchQuery(query), query, users: new Set() };
        guild.queries.set(key, entry);
    }
    entry.users.add(userId);
}

function indexRemoveUser(guildId: string, query: string, userId: string): void {
    const guild = subscriptionIndex.get(guildId);
    if (!guild) {
        return;
    }
    const key = normalizeQueryStorageKey(query);
    const entry = guild.queries.get(key);
    if (!entry) {
        return;
    }
    entry.users.delete(userId);
    if (entry.users.size === 0) {
        guild.queries.delete(key);
    }
    if (guild.queries.size === 0 && !guild.channelId) {
        subscriptionIndex.delete(guildId);
    }
}

function readSubscriptionsFromIndex(client: Client): ActiveSubscription[] {
    const results: ActiveSubscription[] = [];
    for (const [guildId, guild] of subscriptionIndex) {
        if (!(client.guilds.cache.has(guildId) && guild.channelId)) {
            continue;
        }
        for (const { parsed, query, users } of guild.queries.values()) {
            if (users.size === 0) {
                continue;
            }
            results.push({
                channelId: guild.channelId,
                guildId,
                parsed,
                query,
                users: Array.from(users),
            });
        }
    }
    return results;
}

function getIndexedQueryWatchers(client: Client, query: string): string[] {
    const key = normalizeQueryStorageKey(query);
    const guildIds: string[] = [];
    for (const [guildId, guild] of subscriptionIndex) {
        if (!(client.guilds.cache.has(guildId) && guild.channelId)) {
            continue;
        }
        const entry = guild.queries.get(key);
        if (entry && entry.users.size > 0) {
            guildIds.push(guildId);
        }
    }
    return guildIds;
}

function getIndexedPollQueries(client: Client): string[] {
    const queries = new Set<string>();
    for (const [guildId, guild] of subscriptionIndex) {
        if (!(client.guilds.cache.has(guildId) && guild.channelId)) {
            continue;
        }
        for (const { query, users } of guild.queries.values()) {
            if (users.size > 0) {
                queries.add(query);
            }
        }
    }
    return Array.from(queries);
}

async function loadPollQueriesFromKeyv(client: Client): Promise<string[]> {
    const guildQueryLists = await Promise.all(
        Array.from(client.guilds.cache.keys(), async (guildId) => {
            const channelId = await getAlertsChannelForGuild(guildId);
            if (!channelId) {
                return [];
            }
            const allQueriesKey = `meta:all_queries:${guildId}`;
            const guildQueries: string[] = (await keyv.get(allQueriesKey)) || [];
            return guildQueries;
        })
    );
    return Array.from(new Set(guildQueryLists.flat()));
}

async function indexLoadGuild(guildId: string): Promise<void> {
    const channelId = (await keyv.get(`${ALERTS_CHANNEL_KEY_PREFIX}${guildId}`)) as
        | string
        | undefined;
    if (channelId) {
        alertsChannelByGuild.set(guildId, channelId);
    } else {
        alertsChannelByGuild.delete(guildId);
    }

    const allQueriesKey = `meta:all_queries:${guildId}`;
    const allQueries: string[] = (await keyv.get(allQueriesKey)) || [];
    const queries = new Map<string, IndexedQuery>();

    await Promise.all(
        allQueries.map(async (query) => {
            const queryKey = `query:${guildId}:${normalizeQueryStorageKey(query)}`;
            const users: string[] = (await keyv.get(queryKey)) || [];
            if (users.length === 0) {
                return;
            }
            queries.set(normalizeQueryStorageKey(query), {
                parsed: parseWatchQuery(query),
                query,
                users: new Set(users),
            });

            const lastSeenKey = getLastSeenKey(guildId, query);
            const lastSeen = ((await keyv.get(lastSeenKey)) as LastSeen | undefined) || {};
            lastSeenCache.set(lastSeenKey, lastSeen);
        })
    );

    if (channelId || queries.size > 0) {
        subscriptionIndex.set(guildId, { channelId, queries });
    } else {
        subscriptionIndex.delete(guildId);
    }
}

/**
 * Rebuilds the in-memory subscription index from SQLite.
 * Call once on ready before connecting to the release stream.
 */
export async function rebuildSubscriptionIndex(client: Client): Promise<void> {
    subscriptionIndex.clear();
    alertsChannelByGuild.clear();
    lastSeenCache.clear();
    indexHydrated = false;

    await Promise.all(Array.from(client.guilds.cache.keys(), (guildId) => indexLoadGuild(guildId)));
    indexHydrated = true;

    const subscriptions = readSubscriptionsFromIndex(client);
    console.log(
        `${'>>'.green} [INDEX] `.white +
            `Loaded ${subscriptions.length} watches across ${subscriptionIndex.size} guilds`.green
    );
}

export async function getAlertsChannelForGuild(guildId: string): Promise<string | undefined> {
    if (indexHydrated) {
        return alertsChannelByGuild.get(guildId);
    }
    return (await keyv.get(`${ALERTS_CHANNEL_KEY_PREFIX}${guildId}`)) as string | undefined;
}

export async function setAlertsChannelForGuild(
    guildId: string,
    channelId: string | null
): Promise<void> {
    if (channelId === null) {
        await keyv.delete(`${ALERTS_CHANNEL_KEY_PREFIX}${guildId}`);
        alertsChannelByGuild.delete(guildId);
        const guild = subscriptionIndex.get(guildId);
        if (guild) {
            guild.channelId = undefined;
            if (guild.queries.size === 0) {
                subscriptionIndex.delete(guildId);
            }
        }
        return;
    }

    await keyv.set(`${ALERTS_CHANNEL_KEY_PREFIX}${guildId}`, channelId);
    alertsChannelByGuild.set(guildId, channelId);
    const guild = getOrCreateIndexedGuild(guildId);
    guild.channelId = channelId;
}

/**
 * Capitalises the first letter of each word in a string.
 * @param str - The string to be capitalised.
 * @returns The capitalised string.
 */
export const capitalise = (str: string): string => str.replace(/\b\w/g, (c) => c.toUpperCase());

/**
 * Deletes a message after a specified delay if it's deletable.
 * @param message - The message to delete.
 * @param time - The delay before deletion, in milliseconds.
 */
export function deletableCheck(message: Message, time: number): void {
    setTimeout(() => {
        message.delete().catch((error) => console.error('Error deleting message:', error));
    }, time);
}

/**
 * Fetches command IDs for both global and guild commands.
 * @param client - The Discord client instance
 * @returns Promise resolving to a record of command names to their IDs
 */
export async function getCommandIds(
    client: Client,
    guildId: string
): Promise<Record<string, string>> {
    if (!client.application) {
        throw new Error('Client application is not available');
    }

    const commandIds = new Map<string, string>();
    const isGuildOnly = client.botGuilds && client.botGuilds.length > 0;

    // Fetch global commands
    if (!isGuildOnly) {
        try {
            const globalCommands = await client.application.commands.fetch();
            for (const cmd of globalCommands.values()) {
                commandIds.set(cmd.name, cmd.id);
            }
        } catch (error) {
            console.warn('Could not fetch global commands:', error);
        }
    }

    // Fetch guild commands
    const guild = client.guilds.cache.get(guildId);
    if (guild) {
        try {
            const guildCommands = await guild.commands.fetch();
            for (const cmd of guildCommands.values()) {
                commandIds.set(cmd.name, cmd.id);
            }
        } catch (error) {
            console.warn(`Could not fetch commands for guild ${guild.name}:`, error);
        }
    }

    return Object.fromEntries(commandIds);
}

/**
 * Updates the status of the Discord client with information about guilds and users.
 * @param client - The Discord client instance.
 */
export function updateStatus(client: Client) {
    client.user?.setActivity({
        name: `${client.guilds.cache.size.toLocaleString('en')} Guilds
            ${client.guilds.cache.reduce((a, b) => a + b.memberCount, 0).toLocaleString('en')} Users`,
        type: ActivityType.Watching,
    });
}

/**
 * Applies a reversed rainbow effect to the input string.
 * @param str - The string to apply the reversed rainbow effect.
 * @returns The input string with reversed rainbow coloring.
 */
export const reversedRainbow = (str: string): string => {
    const colors = ['red', 'magenta', 'blue', 'green', 'yellow', 'red'] as const;
    return str
        .split('')
        .map((char, i) => char[colors[i % colors.length] as keyof typeof char])
        .join('');
};

/**
 * Handles given error by logging it and optionally sending it to a Discord channel.
 * @param client - The Discord client instance
 * @param error - The unknown error
 */
export async function handleError(client: Client, error: unknown): Promise<void> {
    // Properly log the raw error for debugging
    console.error('Raw error:', error);

    // Create an error object if we received something else
    const normalizedError = error instanceof Error ? error : new Error(String(error));

    // Ensure we have a stack trace
    const errorStack = normalizedError.stack || normalizedError.message || String(error);

    if (!(config.ENABLE_LOGGING && config.ERROR_LOGGING_CHANNEL)) {
        return;
    }

    /**
     * Truncates the description if it exceeds the maximum length.
     * @param description - The description to truncate
     * @returns The truncated description
     */
    function truncateDescription(description: string): string {
        const maxLength = 4096;
        if (description.length <= maxLength) {
            return description;
        }
        const numTruncatedChars = description.length - maxLength;
        return `${description.slice(0, maxLength)}... ${numTruncatedChars} more`;
    }

    try {
        const channel = client.channels.cache.get(config.ERROR_LOGGING_CHANNEL!) as
            | TextChannel
            | undefined;

        if (!channel || channel.type !== ChannelType.GuildText) {
            console.error(`Invalid logging channel: ${config.ERROR_LOGGING_CHANNEL}`);
            return;
        }

        const typeOfError = normalizedError.name || 'Unknown Error';
        const timeOfError = `<t:${Math.floor(Date.now() / 1000)}>`;

        const fullString = [
            `From: \`${typeOfError}\``,
            `Time: ${timeOfError}`,
            '',
            'Error:',
            codeBlock('js', errorStack),
        ].join('\n');

        const embed = new EmbedBuilder()
            .setTitle('Error')
            .setDescription(truncateDescription(fullString))
            .setColor('#FF0000');

        await channel.send({ embeds: [embed] });
    } catch (sendError) {
        console.error('Failed to send the error embed:', sendError);
    }
}

/**
 * Checks the health of the API by hitting the /stats endpoint.
 * @returns Promise resolving to true if API is healthy, false otherwise
 */
export async function checkApiHealth(): Promise<boolean> {
    try {
        const response = await axios.get(`${config.API_URL}/stats`);

        // Check if response has expected structure and data
        const isHealthy =
            response.data.status === 'success' &&
            response.data.data &&
            typeof response.data.data.total === 'number' &&
            response.data.data.total > 0;

        if (isHealthy) {
            const totalReleases = response.data.data.total.toLocaleString('en');
            console.log(
                `${'>>'.green} [API STATUS] `.white +
                    `API is healthy! Total releases: ${totalReleases}`.green
            );
        } else {
            console.warn(
                `${'>>'.yellow} [API STATUS] `.white +
                    'API health check failed: Invalid response structure or no data'.yellow
            );
        }

        return isHealthy;
    } catch (error) {
        console.error(`${'>>'.red} [API STATUS] `.white + `API health check failed: ${error}`.red);
        return false;
    }
}

let releaseStreamUp = false;
let pollCatchUpRequested = false;
let wakePollLoop: (() => void) | undefined;

const POLL_PAGE_SIZE = 20;
const POLL_MAX_PAGES = 5;
const POLL_SAFE_REQUESTS_PER_MINUTE = 30;

/**
 * Connects to the WebSocket for real-time release updates.
 * @param onMessage - Callback function to handle incoming release data
 * @returns WebSocket connection instance
 */
export function connectToReleaseStream(onMessage: (data: WebSocketMessage) => void): WebSocket {
    const wsUrl = `${config.API_URL}/ws`;
    const ws = new WebSocket(wsUrl);

    // Heartbeat: a WebSocket can die silently (idle timeout, NAT drop, network blip)
    // without ever emitting 'close', which means the auto-reconnect below never runs
    // and the bot stops receiving releases while appearing healthy. Ping the server
    // regularly; if it stops answering, terminate() the socket so 'close' fires and
    // the existing reconnect logic takes over.
    const HEARTBEAT_INTERVAL_MS = 30_000;
    let isAlive = true;
    let heartbeat: ReturnType<typeof setInterval> | undefined;

    ws.on('open', () => {
        console.log(
            `${'>>'.green} [WEBSOCKET] `.white + 'Connected to real-time release stream'.green
        );

        isAlive = true;
        releaseStreamUp = true;
        pollCatchUpRequested = true;
        wakePollLoop?.();
        heartbeat = setInterval(() => {
            if (!isAlive) {
                console.warn(
                    `${'>>'.yellow} [WEBSOCKET] `.white +
                        'No pong received, terminating stale connection...'.yellow
                );
                ws.terminate();
                return;
            }
            isAlive = false;
            ws.ping();
        }, HEARTBEAT_INTERVAL_MS);
    });

    ws.on('pong', () => {
        isAlive = true;
    });

    ws.on('message', (data: WebSocket.Data) => {
        // Any traffic proves the connection is alive
        isAlive = true;
        try {
            const release = JSON.parse(data.toString());

            // Only process 'insert' actions
            if (release.action === 'insert') {
                console.log(
                    `${'>>'.blue} [WEBSOCKET] `.white +
                        `Received ${release.action}: ${release.row?.name || 'Unknown'}`.blue
                );
                onMessage(release);
            }
        } catch (error) {
            console.error(
                `${'>>'.red} [WEBSOCKET] `.white + `Failed to parse message: ${error}`.red
            );
        }
    });

    ws.on('error', (error) => {
        console.error(`${'>>'.red} [WEBSOCKET] `.white + `Connection error: ${error}`.red);
    });

    ws.on('close', (code, reason) => {
        if (heartbeat) {
            clearInterval(heartbeat);
            heartbeat = undefined;
        }

        console.warn(
            `${'>>'.yellow} [WEBSOCKET] `.white + `Connection closed: ${code} - ${reason}`.yellow
        );

        releaseStreamUp = false;
        wakePollLoop?.();

        // Auto-reconnect after 5 seconds
        setTimeout(() => {
            console.log(`${'>>'.cyan} [WEBSOCKET] `.white + 'Attempting to reconnect...'.cyan);
            connectToReleaseStream(onMessage);
        }, 5000);
    });

    return ws;
}

/**
 * Polls PreDB only while the WebSocket is down, plus one catch-up after
 * connect/reconnect. Pages by lastSeen watermark instead of a fixed last-5.
 */
export async function startPollingFallback(client: Client, signal?: AbortSignal): Promise<void> {
    if (!config.POLLING_ENABLED) {
        return;
    }

    let lastEffectiveIntervalSec = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let running = false;
    let retrigger = false;

    const schedule = (ms: number) => {
        if (timer) {
            clearTimeout(timer);
        }
        timer = setTimeout(() => {
            loop().catch((error) => {
                console.error(`${'>>'.red} [POLL] `.white + `Loop error: ${error}`.red);
            });
        }, ms);
    };

    wakePollLoop = () => {
        if (running) {
            retrigger = true;
            return;
        }
        schedule(0);
    };

    const loop = async () => {
        if (running) {
            return;
        }
        running = true;
        try {
            const shouldFetch = !releaseStreamUp || pollCatchUpRequested;
            const allQueries = indexHydrated
                ? getIndexedPollQueries(client)
                : await loadPollQueriesFromKeyv(client);

            const baseIntervalSec = config.POLLING_INTERVAL_SECONDS;
            const requiredIntervalSec =
                allQueries.length > 0
                    ? Math.ceil((allQueries.length * 60) / POLL_SAFE_REQUESTS_PER_MINUTE)
                    : baseIntervalSec;
            const effectiveIntervalSec = Math.max(baseIntervalSec, requiredIntervalSec);

            if (effectiveIntervalSec !== lastEffectiveIntervalSec) {
                const rpm =
                    allQueries.length > 0
                        ? ((allQueries.length * 60) / effectiveIntervalSec).toFixed(1)
                        : '0.0';
                console.log(
                    `${'>>'.cyan} [POLL] `.white +
                        `Interval set to ${effectiveIntervalSec}s for ${allQueries.length} queries (~${rpm} req/min)`
                            .cyan
                );
                lastEffectiveIntervalSec = effectiveIntervalSec;
            }

            if (!shouldFetch) {
                schedule(baseIntervalSec * 1000);
                return;
            }

            if (allQueries.length === 0) {
                pollCatchUpRequested = false;
                schedule(baseIntervalSec * 1000);
                return;
            }

            const reason = releaseStreamUp ? 'catch-up after WebSocket connect' : 'WebSocket down';
            console.log(
                `${'>>'.cyan} [POLL] `.white +
                    `Running ${allQueries.length} queries (${reason})`.cyan
            );

            const tickStartMs = Date.now();
            const perRequestDelayMs = Math.ceil(60_000 / POLL_SAFE_REQUESTS_PER_MINUTE);

            for (const query of allQueries) {
                // biome-ignore lint/performance/noAwaitInLoops: requests are intentionally sequential and paced to respect the API rate limit
                await pollQueryCatchUp(client, query, perRequestDelayMs);
            }

            pollCatchUpRequested = false;
            const elapsedMs = Date.now() - tickStartMs;
            const nextDelayMs = releaseStreamUp
                ? Math.max(baseIntervalSec * 1000, 0)
                : Math.max(0, effectiveIntervalSec * 1000 - elapsedMs);

            console.log(
                `${'>>'.green} [POLL] `.white +
                    `Completed ${allQueries.length} queries in ${(elapsedMs / 1000).toFixed(1)}s, next cycle in ${(nextDelayMs / 1000).toFixed(1)}s`
                        .green
            );

            schedule(nextDelayMs);
        } catch (error) {
            console.error(`${'>>'.red} [POLL] `.white + `Loop error: ${error}`.red);
            schedule(config.POLLING_INTERVAL_SECONDS * 1000);
        } finally {
            running = false;
            if (retrigger) {
                retrigger = false;
                schedule(0);
            }
        }
    };

    await loop();

    if (signal) {
        signal.addEventListener('abort', () => {
            if (timer) {
                clearTimeout(timer);
            }
            wakePollLoop = undefined;
        });
    }
}

async function oldestWatermarkForQuery(
    guildIds: string[],
    query: string
): Promise<LastSeen | undefined> {
    const seenList = await Promise.all(
        guildIds.map((guildId) => getLastSeenForGuildQuery(guildId, query))
    );
    const withMark = seenList.filter((seen) => typeof seen.preAt === 'number');
    if (withMark.length === 0) {
        return;
    }
    return withMark.reduce((oldest, seen) =>
        (seen.preAt ?? 0) < (oldest.preAt ?? 0) ? seen : oldest
    );
}

async function fetchReleasesNewerThan(
    search: string,
    watermark: LastSeen,
    perRequestDelayMs: number
): Promise<Release[]> {
    const collected: Release[] = [];
    const offsets = Array.from({ length: POLL_MAX_PAGES }, (_, page) => page * POLL_PAGE_SIZE);

    for (const offset of offsets) {
        if (offset > 0) {
            // biome-ignore lint/performance/noAwaitInLoops: pages are paced to stay under the API rate limit
            await delay(perRequestDelayMs);
        }

        const url = `${config.API_URL}/?q=${encodeURIComponent(search)}&count=${POLL_PAGE_SIZE}&offset=${offset}`;
        try {
            const resp = await axios.get(url);
            const rows = resp?.data?.data?.rows as Release[] | undefined;
            if (!rows || rows.length === 0) {
                break;
            }

            let hitWatermark = false;
            for (const row of rows) {
                if (isAlreadySeen(watermark, row)) {
                    hitWatermark = true;
                    break;
                }
                collected.push(row);
            }

            if (hitWatermark || rows.length < POLL_PAGE_SIZE) {
                break;
            }
            if (offset >= (POLL_MAX_PAGES - 1) * POLL_PAGE_SIZE) {
                console.warn(
                    `${'>>'.yellow} [POLL] `.white +
                        `Hit ${POLL_MAX_PAGES} page cap for "${search}"; older unseen releases may remain`
                            .yellow
                );
            }
        } catch (err) {
            console.warn(
                `${'>>'.yellow} [POLL] `.white +
                    `Failed page offset ${offset} for "${search}": ${err}`.yellow
            );
            break;
        }
    }

    return collected.sort((a, b) => a.preAt - b.preAt);
}

async function pollQueryCatchUp(
    client: Client,
    query: string,
    perRequestDelayMs: number
): Promise<void> {
    const watchers = getIndexedQueryWatchers(client, query);
    const now = Math.floor(Date.now() / 1000);
    const watermark = await oldestWatermarkForQuery(watchers, query);

    for (const guildId of watchers) {
        // biome-ignore lint/performance/noAwaitInLoops: seed each guild that has never been watermarked
        await seedLastSeenIfAbsent(guildId, query, now);
    }

    if (!watermark) {
        await delay(perRequestDelayMs);
        return;
    }

    const search = pollSearchString(query);
    try {
        const rows = await fetchReleasesNewerThan(search, watermark, perRequestDelayMs);
        for (const row of rows) {
            const wsLike: WebSocketMessage = { action: 'insert', row };
            // biome-ignore lint/performance/noAwaitInLoops: releases must be processed in preAt order so dedupe state stays consistent
            await processReleaseNotification(client, wsLike);
        }
    } catch (err) {
        console.warn(`${'>>'.yellow} [POLL] `.white + `Failed query for "${query}": ${err}`.yellow);
    }

    await delay(perRequestDelayMs);
}

/**
 * Gets all active subscriptions. After ready, this is an in-memory read.
 */
export async function getAllActiveSubscriptions(client: Client): Promise<ActiveSubscription[]> {
    if (indexHydrated) {
        return readSubscriptionsFromIndex(client);
    }

    const guildSubscriptions = await Promise.all(
        Array.from(client.guilds.cache.keys(), async (guildId) => {
            const channelId = await getAlertsChannelForGuild(guildId);
            if (!channelId) {
                return [];
            }

            const allQueriesKey = `meta:all_queries:${guildId}`;
            const allQueries: string[] = (await keyv.get(allQueriesKey)) || [];
            const queryResults = await Promise.all(
                allQueries.map(async (query) => {
                    const queryKey = `query:${guildId}:${normalizeQueryStorageKey(query)}`;
                    const users = await keyv.get(queryKey);

                    if (users && Array.isArray(users) && users.length > 0) {
                        return {
                            channelId,
                            guildId,
                            parsed: parseWatchQuery(query),
                            query,
                            users,
                        };
                    }
                    return null;
                })
            );
            return queryResults.filter((result) => result !== null);
        })
    );

    return guildSubscriptions.flat();
}

/**
 * Adds a query to the global queries list for tracking
 * @param query - The query to add
 */
export async function addToGlobalQueries(guildId: string, query: string): Promise<void> {
    const allQueriesKey = `meta:all_queries:${guildId}`;
    const allQueries: string[] = (await keyv.get(allQueriesKey)) || [];

    if (!allQueries.includes(query)) {
        allQueries.push(query);
        await keyv.set(allQueriesKey, allQueries);
    }
}

/**
 * Persists a user on a query watch and updates the in-memory index.
 */
export async function addQuerySubscriber(
    guildId: string,
    query: string,
    userId: string
): Promise<void> {
    const queryKey = `query:${guildId}:${normalizeQueryStorageKey(query)}`;
    const queryUsers: string[] = (await keyv.get(queryKey)) || [];
    if (!queryUsers.includes(userId)) {
        queryUsers.push(userId);
        await keyv.set(queryKey, queryUsers);
        await addToGlobalQueries(guildId, query);
    }
    indexAddUser(guildId, query, userId);
    await seedLastSeenIfAbsent(guildId, query, Math.floor(Date.now() / 1000));
}

/**
 * Removes a query from the global queries list
 * @param query - The query to remove
 */
export async function removeFromGlobalQueries(guildId: string, query: string): Promise<void> {
    const allQueriesKey = `meta:all_queries:${guildId}`;
    const allQueries: string[] = (await keyv.get(allQueriesKey)) || [];

    const updatedQueries = allQueries.filter((q) => q !== query);

    if (updatedQueries.length === 0) {
        await keyv.delete(allQueriesKey);
    } else {
        await keyv.set(allQueriesKey, updatedQueries);
    }
}

/**
 * Processes a new release and notifies users with matching subscriptions
 * @param client - Discord client for sending notifications
 * @param release - The release data from WebSocket
 */
export async function processReleaseNotification(
    client: Client,
    release: WebSocketMessage
): Promise<void> {
    if (release.action !== 'insert' || !release.row) {
        return;
    }

    const { row } = release;

    try {
        const subscriptions = await getAllActiveSubscriptions(client);
        const matchedQueries = new Set<string>();
        const isTestRelease = row.id === 999_999;

        // Different guild+query pairs can notify in parallel. The same query is
        // serialized so lastSeen cannot race across overlapping WS/poll inserts.
        await Promise.all(
            subscriptions.map(async (subscription) => {
                const { guildId, channelId, parsed, query, users } = subscription;

                if (!releaseMatchesParsed(parsed, row)) {
                    return;
                }

                await withLastSeenLock(guildId, query, async () => {
                    const shouldNotify = isTestRelease
                        ? true
                        : !(await getLastSeenForGuildQuery(guildId, query).then((lastSeen) =>
                              isAlreadySeen(lastSeen, row)
                          ));

                    if (!shouldNotify) {
                        console.log(
                            `${'>>'.blue} [DEDUPE] `.white +
                                `Skipping duplicate for query "${query}": ${row.name}`.blue
                        );
                        return;
                    }

                    const sent = await sendBatchedNotification(
                        client,
                        channelId,
                        users,
                        row,
                        query
                    );

                    if (!sent) {
                        console.warn(
                            `${'>>'.yellow} [NOTIFICATION] `.white +
                                `Send failed for query "${query}"; lastSeen left unchanged so this release can retry`
                                    .yellow
                        );
                        return;
                    }

                    matchedQueries.add(`${guildId}:${query}`);
                    if (!isTestRelease) {
                        await setLastSeenForGuildQuery(guildId, query, row);
                    }
                });
            })
        );

        if (matchedQueries.size > 0) {
            console.log(
                `${'>>'.green} [NOTIFICATION] `.white +
                    `Found ${matchedQueries.size} matching queries for: ${row.name}`.green
            );
        }
    } catch (error) {
        console.error(`${'>>'.red} [NOTIFICATION] `.white + 'Error processing release'.red);
        await handleError(client, error);
    }
}

/**
 * Sends a batched notification to multiple users about a matching release.
 * @returns true if Discord accepted the message (caller may then ack lastSeen)
 */
export async function sendBatchedNotification(
    client: Client,
    channelId: string,
    userIds: string[],
    release: Release,
    matchedQuery: string
): Promise<boolean> {
    if (userIds.length === 0) {
        return false;
    }

    try {
        const releaseText = new TextDisplayBuilder().setContent(
            [
                `## 📦 ${release.name}`,
                `**Team:** \`${release.team}\``,
                `**Category:** \`${release.cat}\``,
            ].join('\n')
        );

        const detailsText = new TextDisplayBuilder().setContent(
            [
                '### Release Details',
                release.files > 0 ? `**Files:** \`${release.files}\`` : null,
                release.size > 0 ? `**Size:** \`${release.size} MB\`` : null,
                `**Pre Time:** <t:${release.preAt}:R>`,
            ]
                .filter(Boolean)
                .join('\n')
        );

        const channel =
            client.channels.cache.get(channelId) ??
            (await client.channels.fetch(channelId).catch(() => null));
        const canSendToChannel = channel?.isTextBased() && channel && 'send' in channel;
        if (!canSendToChannel) {
            console.error(
                `${'>>'.red} [NOTIFICATION] `.white +
                    `Cannot send to channel ${channelId}: missing or not text-based`.red
            );
            return false;
        }
        const userIdsToPing = Array.from(new Set(userIds));
        const pings = userIdsToPing.map((id) => `<@${id}>`).join(' ');
        const containerWithPings = new ContainerBuilder();
        const headerWithPings = new TextDisplayBuilder().setContent(
            ['# 🎯 New Release Match!', `-# Query: \`${matchedQuery}\``, `-# ${pings}`].join('\n')
        );
        containerWithPings.addTextDisplayComponents(headerWithPings);
        containerWithPings.addSeparatorComponents((separator) =>
            separator.setSpacing(SeparatorSpacingSize.Large)
        );
        containerWithPings.addTextDisplayComponents(releaseText);
        containerWithPings.addSeparatorComponents((separator) =>
            separator.setSpacing(SeparatorSpacingSize.Large)
        );
        containerWithPings.addTextDisplayComponents(detailsText);
        const guildId = (channel as TextChannel).guild.id;
        const encodedQuery = encodeURIComponent(matchedQuery);
        const unsubButtonChannel = new ButtonBuilder()
            .setCustomId(`unsub:${guildId}:${encodedQuery}`)
            .setLabel('Unsubscribe')
            .setStyle(ButtonStyle.Danger);
        containerWithPings.addActionRowComponents((row) => row.addComponents(unsubButtonChannel));

        const sendAttempt = async (attempt: number): Promise<boolean> => {
            try {
                await (channel as TextChannel).send({
                    components: [containerWithPings],
                    flags: MessageFlags.IsComponentsV2,
                });
                console.log(
                    `${'>>'.green} [NOTIFICATION] `.white +
                        `Sent to channel ${channel.id} (${userIdsToPing.length} users)`.green
                );
                console.log(
                    `${'>>'.green} [NOTIFICATION] `.white +
                        `Notified ${userIdsToPing.length} users about: ${release.name} (query: ${matchedQuery})`
                            .green
                );
                return true;
            } catch (error) {
                const willRetry = !isNonRetryableSendError(error) && attempt < NOTIFY_SEND_ATTEMPTS;
                console.error(
                    `${'>>'.red} [NOTIFICATION] `.white +
                        `Failed to send to channel ${channel.id} (attempt ${attempt}/${NOTIFY_SEND_ATTEMPTS})`
                            .red
                );
                if (!willRetry) {
                    await handleError(client, error);
                    return false;
                }
                await delay(NOTIFY_RETRY_DELAY_MS * attempt);
                return sendAttempt(attempt + 1);
            }
        };

        return sendAttempt(1);
    } catch (error) {
        console.error(
            `${'>>'.red} [NOTIFICATION] `.white + `Error sending batch notification: ${error}`.red
        );
        await handleError(client, error);
        return false;
    }
}

/**
 * Simulates a release for testing notifications (call this from console or add a simple command)
 * @param client - Discord client
 * @param releaseName - Name of the fake release
 */
export async function testNotification(client: Client, releaseName: string): Promise<void> {
    const preAt = Math.floor(Date.now() / 1000);
    const mockRelease = {
        action: 'insert' as const,
        row: {
            cat: 'X264-HD-720P',
            files: 15,
            genre: '',
            id: 999_999,
            name: releaseName,
            nuke: null,
            preAt,
            size: 2048,
            team: 'TEST',
            url: '',
        },
    };

    console.log(`🧪 [TEST] Simulating release: ${releaseName}`.cyan);
    await processReleaseNotification(client, mockRelease);
}

/**
 * Unsubscribes a user from a specific query
 * @param userId - The user ID to unsubscribe
 * @param query - The query to unsubscribe from
 * @returns Promise resolving to unsubscribe result
 */
export async function unsubscribeFromQuery(
    userId: string,
    guildId: string,
    query: string
): Promise<{
    success: boolean;
    message?: string;
}> {
    try {
        const userKey = `user:${guildId}:${userId}`;

        // Get user's subscriptions
        const userSubs: Array<{ id: string; query: string; created: number }> =
            (await keyv.get(userKey)) || [];

        // Find subscriptions matching this query
        const matchingSubs = userSubs.filter((sub) => sub.query === query);
        if (matchingSubs.length === 0) {
            return { message: '❌ You are not subscribed to this query.', success: false };
        }

        // Use the first matching subscription's ID to delete
        const result = await deleteSubscription(guildId, userId, matchingSubs[0]!.id);

        if (result.success) {
            return {
                message: `✅ Unsubscribed from "${query}"`,
                success: true,
            };
        }

        return result;
    } catch (error) {
        console.error('Error unsubscribing from query:', error);
        return { message: '❌ Failed to unsubscribe. Try again later.', success: false };
    }
}

/**
 * Deletes a subscription by subscription ID and handles cleanup
 * @param userId - The user ID who owns the subscription
 * @param subscriptionId - The specific subscription ID to delete
 * @returns Promise resolving to deletion result
 */
export async function deleteSubscription(
    guildId: string,
    userId: string,
    subscriptionId: string
): Promise<{
    success: boolean;
    message?: string;
    deletedQuery?: string;
}> {
    try {
        const userKey = `user:${guildId}:${userId}`;

        // Get user's subscriptions
        const userSubs: Array<{ id: string; query: string; created: number }> =
            (await keyv.get(userKey)) || [];

        // Find the subscription to delete
        const subToDelete = userSubs.find((sub) => sub.id === subscriptionId);
        if (!subToDelete) {
            return { message: '❌ Subscription not found.', success: false };
        }

        // Remove from user subscriptions
        const updatedUserSubs = userSubs.filter((sub) => sub.id !== subscriptionId);

        if (updatedUserSubs.length === 0) {
            // No more subscriptions, delete user key entirely
            await keyv.delete(userKey);
        } else {
            // Update user subscriptions
            await keyv.set(userKey, updatedUserSubs);
        }

        // Handle query cleanup
        const queryKey = `query:${guildId}:${normalizeQueryStorageKey(subToDelete.query)}`;
        const queryUsers: string[] = (await keyv.get(queryKey)) || [];

        // Remove user from query subscribers
        const updatedQueryUsers = queryUsers.filter((id) => id !== userId);

        if (updatedQueryUsers.length === 0) {
            // No more users monitoring this query, delete the query key entirely
            await keyv.delete(queryKey);
            // Remove from global queries tracking
            await removeFromGlobalQueries(guildId, subToDelete.query);
        } else {
            // Update query subscribers
            await keyv.set(queryKey, updatedQueryUsers);
        }

        indexRemoveUser(guildId, subToDelete.query, userId);

        return {
            deletedQuery: subToDelete.query,
            message: `✅ Stopped monitoring "${subToDelete.query}"`,
            success: true,
        };
    } catch (error) {
        console.error('Error deleting subscription:', error);
        return { message: '❌ Failed to delete subscription. Try again later.', success: false };
    }
}
