import {
    ActivityType,
    ButtonBuilder,
    ButtonStyle,
    ChannelType,
    ContainerBuilder,
    codeBlock,
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
type Nuke = {
    id: number;
    typeId: number;
    type: string;
    preId: number;
    reason: string;
    net: string;
    nukeAt: number;
};

type Release = {
    id: number;
    name: string;
    team: string;
    cat: string;
    genre: string;
    url: string;
    size: number;
    files: number;
    preAt: number;
    nuke: Nuke | null;
};

type WebSocketMessage = {
    action: 'insert' | 'update' | 'delete' | 'nuke' | 'unnuke' | 'modnuke' | 'delpre' | 'undelpre';
    row: Release;
};

export const keyv = new Keyv({
    store: new KeyvSqlite({ uri: 'sqlite://src/data/db.sqlite' }),
    namespace: 'data',
});
keyv.on('error', (err) => console.log('[keyv] Connection Error', err));

// ---------------------------
// Last-seen tracking helpers
// ---------------------------
type LastSeen = { id?: number; preAt?: number };

function normalizeQueryStorageKey(query: string): string {
    return query.toLowerCase().replace(/\s+/g, '+').trim();
}

function getLastSeenKey(query: string): string {
    const normalized = normalizeQueryStorageKey(query);
    return `lastSeen:${normalized}`;
}

export async function getLastSeenForQuery(query: string): Promise<LastSeen> {
    const key = getLastSeenKey(query);
    const value = ((await keyv.get(key)) as LastSeen | undefined) || {};
    return value;
}

export async function setLastSeenForQuery(query: string, release: Release): Promise<void> {
    const key = getLastSeenKey(query);
    const payload: LastSeen = { id: release.id, preAt: release.preAt };
    await keyv.set(key, payload);
}

// ---------------------------
// Per-guild alerts channel (for channel notification mode)
// ---------------------------
const ALERTS_CHANNEL_KEY_PREFIX = 'alertsChannel:';

export async function getAlertsChannelForGuild(guildId: string): Promise<string | undefined> {
    return (await keyv.get(`${ALERTS_CHANNEL_KEY_PREFIX}${guildId}`)) as string | undefined;
}

export async function setAlertsChannelForGuild(
    guildId: string,
    channelId: string | null
): Promise<void> {
    if (channelId === null) {
        await keyv.delete(`${ALERTS_CHANNEL_KEY_PREFIX}${guildId}`);
    } else {
        await keyv.set(`${ALERTS_CHANNEL_KEY_PREFIX}${guildId}`, channelId);
    }
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
        type: ActivityType.Watching,
        name: `${client.guilds.cache.size.toLocaleString('en')} Guilds
            ${client.guilds.cache.reduce((a, b) => a + b.memberCount, 0).toLocaleString('en')} Users`,
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

/**
 * Connects to the WebSocket for real-time release updates.
 * @param onMessage - Callback function to handle incoming release data
 * @returns WebSocket connection instance
 */
export function connectToReleaseStream(onMessage: (data: WebSocketMessage) => void): WebSocket {
    const wsUrl = `${config.API_URL}/ws`;
    const ws = new WebSocket(wsUrl);

    ws.on('open', () => {
        console.log(
            `${'>>'.green} [WEBSOCKET] `.white + 'Connected to real-time release stream'.green
        );
    });

    ws.on('message', (data: WebSocket.Data) => {
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
        console.warn(
            `${'>>'.yellow} [WEBSOCKET] `.white + `Connection closed: ${code} - ${reason}`.yellow
        );

        // Auto-reconnect after 5 seconds
        setTimeout(() => {
            console.log(`${'>>'.cyan} [WEBSOCKET] `.white + 'Attempting to reconnect...'.cyan);
            connectToReleaseStream(onMessage);
        }, 5000);
    });

    return ws;
}

/**
 * Poll recent releases for each subscribed query as a fallback if websocket misses.
 * Respects API rate limits via env-configured caps and intervals.
 */
export async function startPollingFallback(client: Client, signal?: AbortSignal): Promise<void> {
    if (!config.POLLING_ENABLED) {
        return;
    }

    const SAFE_REQUESTS_PER_MINUTE = 30;
    let lastEffectiveIntervalSec = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const loop = async () => {
        try {
            const allQueriesKey = 'meta:all_queries';
            const allQueries: string[] = (await keyv.get(allQueriesKey)) || [];

            // Compute interval that allows polling ALL queries each tick while respecting 30 rpm
            const baseIntervalSec = config.POLLING_INTERVAL_SECONDS;
            const requiredIntervalSec =
                allQueries.length > 0
                    ? Math.ceil((allQueries.length * 60) / SAFE_REQUESTS_PER_MINUTE)
                    : baseIntervalSec;
            const effectiveIntervalSec = Math.max(baseIntervalSec, requiredIntervalSec);

            // Log when interval changes or on first run
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
                if (effectiveIntervalSec > baseIntervalSec) {
                    console.warn(
                        `${'>>'.yellow} [POLL] `.white +
                            `Auto-scaled interval from ${baseIntervalSec}s to ${effectiveIntervalSec}s to respect API budget`
                                .yellow
                    );
                }
                lastEffectiveIntervalSec = effectiveIntervalSec;
            }

            if (allQueries.length === 0) {
                // Schedule next check using base interval if no queries
                timer = setTimeout(loop, baseIntervalSec * 1000);
                return;
            }

            // Poll ALL queries this tick (interval has been scaled to fit budget)
            // Track start to schedule next run accurately
            const tickStartMs = Date.now();

            // Pace requests to avoid burst rate-limits within the tick
            const perRequestDelayMs = Math.ceil(60_000 / SAFE_REQUESTS_PER_MINUTE);
            for (const query of allQueries) {
                const url = `${config.API_URL}/?q=${encodeURIComponent(query)}&count=5`;

                try {
                    const resp = await axios.get(url);
                    const rows = resp?.data?.data?.rows as Release[] | undefined;
                    if (!rows || rows.length === 0) {
                        continue;
                    }

                    const { preAt: lastPreAt } = await getLastSeenForQuery(query);
                    const newRows = rows
                        .filter((r) => (typeof lastPreAt === 'number' ? r.preAt > lastPreAt : true))
                        .sort((a, b) => a.preAt - b.preAt);

                    for (const row of newRows) {
                        const wsLike: WebSocketMessage = { action: 'insert', row };
                        await processReleaseNotification(client, wsLike);
                        await setLastSeenForQuery(query, row);
                    }
                } catch (err) {
                    console.warn(
                        `${'>>'.yellow} [POLL] `.white +
                            `Failed query for "${query}": ${err}`.yellow
                    );
                }

                // Space out requests to stay under rolling 30 req/min budget
                await new Promise((resolve) => setTimeout(resolve, perRequestDelayMs));
            }

            // Schedule next run considering time already spent in this tick
            const elapsedMs = Date.now() - tickStartMs;
            const targetTickMs = lastEffectiveIntervalSec * 1000;
            const nextDelayMs = Math.max(0, targetTickMs - elapsedMs);

            console.log(
                `${'>>'.green} [POLL] `.white +
                    `Completed ${allQueries.length} queries in ${(elapsedMs / 1000).toFixed(1)}s, next cycle in ${(nextDelayMs / 1000).toFixed(1)}s`
                        .green
            );

            timer = setTimeout(loop, nextDelayMs);
        } catch (error) {
            console.error(`${'>>'.red} [POLL] `.white + `Loop error: ${error}`.red);
            // In case of error, try again after base interval
            timer = setTimeout(loop, config.POLLING_INTERVAL_SECONDS * 1000);
        }
    };

    // Kick off polling
    await loop();

    if (signal) {
        signal.addEventListener('abort', () => {
            if (timer) {
                clearTimeout(timer);
            }
        });
    }
}

/**
 * Gets all active subscriptions from the database
 * @returns Array of subscription objects with query and user arrays
 */
export async function getAllActiveSubscriptions(): Promise<
    Array<{ query: string; users: string[] }>
> {
    // Since Keyv doesn't provide a direct way to get all keys, we'll use a workaround
    // This is not the most efficient but works for the current setup
    const subscriptions: Array<{ query: string; users: string[] }> = [];

    // We maintain a list of all query keys separately
    const allQueriesKey = 'meta:all_queries';
    const allQueries: string[] = (await keyv.get(allQueriesKey)) || [];

    for (const query of allQueries) {
        const queryKey = `query:${query.toLowerCase().replace(/\s+/g, '+')}`;
        const users = await keyv.get(queryKey);

        if (users && Array.isArray(users) && users.length > 0) {
            subscriptions.push({ query, users });
        }
    }

    return subscriptions;
}

/**
 * Checks if a query matches a release name using fuzzy matching
 * @param query - The search query
 * @param releaseName - The release name (already lowercased)
 * @returns True if the query matches the release
 */
export function isQueryMatch(query: string, releaseName: string): boolean {
    // Normalize both query and release name
    const normalizedQuery = query
        .toLowerCase()
        .replace(/[.\-_]/g, ' ')
        .trim();
    const normalizedRelease = releaseName.replace(/[.\-_]/g, ' ').trim();

    // Split into words (filter out short words)
    const queryWords = normalizedQuery.split(/\s+/).filter((word) => word.length >= 3);

    if (queryWords.length === 0) {
        return false;
    }

    // Check if all query words are present in the release name
    return queryWords.every((word) => normalizedRelease.includes(word));
}

/**
 * Adds a query to the global queries list for tracking
 * @param query - The query to add
 */
export async function addToGlobalQueries(query: string): Promise<void> {
    const allQueriesKey = 'meta:all_queries';
    const allQueries: string[] = (await keyv.get(allQueriesKey)) || [];

    if (!allQueries.includes(query)) {
        allQueries.push(query);
        await keyv.set(allQueriesKey, allQueries);
    }
}

/**
 * Removes a query from the global queries list
 * @param query - The query to remove
 */
export async function removeFromGlobalQueries(query: string): Promise<void> {
    const allQueriesKey = 'meta:all_queries';
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

    const releaseName = release.row.name.toLowerCase();

    try {
        // Get all active subscriptions and check for matches
        const subscriptions = await getAllActiveSubscriptions();
        const matchedQueries = new Set<string>();

        const notificationBatches = new Map<string, Set<string>>();

        const isTestRelease = release.row.id === 999_999;

        for (const subscription of subscriptions) {
            const { query, users } = subscription;

            // Check if the query matches the release name
            if (isQueryMatch(query, releaseName)) {
                const shouldNotify = isTestRelease
                    ? true
                    : await getLastSeenForQuery(query).then(({ preAt: lastPreAt }) =>
                          typeof lastPreAt === 'number' ? release.row.preAt > lastPreAt : true
                      );

                if (shouldNotify) {
                    matchedQueries.add(query);
                    if (!isTestRelease) {
                        await setLastSeenForQuery(query, release.row);
                    }

                    if (!notificationBatches.has(query)) {
                        notificationBatches.set(query, new Set());
                    }

                    for (const userId of users) {
                        notificationBatches.get(query)!.add(userId);
                    }
                } else {
                    console.log(
                        `${'>>'.blue} [DEDUPE] `.white +
                            `Skipping duplicate for query "${query}": ${release.row.name}`.blue
                    );
                }
            }
        }

        // Send batched notifications
        for (const [query, userIds] of notificationBatches) {
            await sendBatchedNotification(client, Array.from(userIds), release.row, query);
        }

        if (matchedQueries.size > 0) {
            console.log(
                `${'>>'.green} [NOTIFICATION] `.white +
                    `Found ${matchedQueries.size} matching queries for: ${release.row.name}`.green
            );
        }
    } catch (error) {
        console.error(`${'>>'.red} [NOTIFICATION] `.white + 'Error processing release'.red);
        await handleError(client, error);
    }
}

/**
 * Sends a batched notification to multiple users about a matching release
 * @param client - Discord client
 * @param userIds - Array of user IDs to notify
 * @param release - Release data
 * @param matchedQuery - The query that matched
 */
export async function sendBatchedNotification(
    client: Client,
    userIds: string[],
    release: Release,
    matchedQuery: string
): Promise<void> {
    if (userIds.length === 0) {
        return;
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

        // Build channelId -> set of user IDs to ping (users in guilds that use this channel).
        const channelToUserIds = new Map<string, Set<string>>();
        for (const [guildId] of client.guilds.cache) {
            const channelId = await getAlertsChannelForGuild(guildId);
            if (!channelId) {
                continue;
            }
            if (!channelToUserIds.has(channelId)) {
                channelToUserIds.set(channelId, new Set());
            }
            for (const id of userIds) {
                channelToUserIds.get(channelId)!.add(id);
            }
        }
        for (const [channelId, userIdSet] of channelToUserIds) {
            const channel =
                client.channels.cache.get(channelId) ??
                (await client.channels.fetch(channelId).catch(() => null));
            const canSendToChannel = channel?.isTextBased() && channel && 'send' in channel;
            if (!canSendToChannel) {
                continue;
            }
            const userIdsToPing = Array.from(userIdSet);
            const pings = userIdsToPing.map((id) => `<@${id}>`).join(' ');
            const containerWithPings = new ContainerBuilder();
            const headerWithPings = new TextDisplayBuilder().setContent(
                ['# 🎯 New Release Match!', `-# Query: \`${matchedQuery}\``, `-# ${pings}`].join(
                    '\n'
                )
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
            const unsubButtonChannel = new ButtonBuilder()
                .setCustomId(`unsub:${matchedQuery}`)
                .setLabel('Unsubscribe')
                .setStyle(ButtonStyle.Danger);
            containerWithPings.addActionRowComponents((row) =>
                row.addComponents(unsubButtonChannel)
            );

            await (channel as TextChannel)
                .send({
                    components: [containerWithPings],
                    flags: MessageFlags.IsComponentsV2,
                })
                .then(() => {
                    console.log(
                        `${'>>'.green} [NOTIFICATION] `.white +
                            `Sent to channel ${channel.id} (${userIdsToPing.length} users)`.green
                    );
                })
                .catch(async (error: unknown) => {
                    console.error(
                        `${'>>'.red} [NOTIFICATION] `.white +
                            `Failed to send to channel ${channel.id}`.red
                    );
                    await handleError(client, error);
                });
        }

        console.log(
            `${'>>'.green} [NOTIFICATION] `.white +
                `Notified ${userIds.length} users about: ${release.name} (query: ${matchedQuery})`
                    .green
        );
    } catch (error) {
        console.error(
            `${'>>'.red} [NOTIFICATION] `.white + `Error sending batch notification: ${error}`.red
        );
        await handleError(client, error);
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
            id: 999_999,
            name: releaseName,
            team: 'TEST',
            cat: 'X264-HD-720P',
            genre: '',
            url: '',
            size: 2048,
            files: 15,
            preAt,
            nuke: null,
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
    query: string
): Promise<{
    success: boolean;
    message?: string;
}> {
    try {
        const userKey = `user:${userId}`;

        // Get user's subscriptions
        const userSubs: Array<{ id: string; query: string; created: number }> =
            (await keyv.get(userKey)) || [];

        // Find subscriptions matching this query
        const matchingSubs = userSubs.filter((sub) => sub.query === query);
        if (matchingSubs.length === 0) {
            return { success: false, message: '❌ You are not subscribed to this query.' };
        }

        // Use the first matching subscription's ID to delete
        const result = await deleteSubscription(userId, matchingSubs[0]!.id);

        if (result.success) {
            return {
                success: true,
                message: `✅ Unsubscribed from "${query}"`,
            };
        }

        return result;
    } catch (error) {
        console.error('Error unsubscribing from query:', error);
        return { success: false, message: '❌ Failed to unsubscribe. Try again later.' };
    }
}

/**
 * Deletes a subscription by subscription ID and handles cleanup
 * @param userId - The user ID who owns the subscription
 * @param subscriptionId - The specific subscription ID to delete
 * @returns Promise resolving to deletion result
 */
export async function deleteSubscription(
    userId: string,
    subscriptionId: string
): Promise<{
    success: boolean;
    message?: string;
    deletedQuery?: string;
}> {
    try {
        const userKey = `user:${userId}`;

        // Get user's subscriptions
        const userSubs: Array<{ id: string; query: string; created: number }> =
            (await keyv.get(userKey)) || [];

        // Find the subscription to delete
        const subToDelete = userSubs.find((sub) => sub.id === subscriptionId);
        if (!subToDelete) {
            return { success: false, message: '❌ Subscription not found.' };
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
        const queryKey = `query:${subToDelete.query.toLowerCase().replace(/\s+/g, '+')}`;
        const queryUsers: string[] = (await keyv.get(queryKey)) || [];

        // Remove user from query subscribers
        const updatedQueryUsers = queryUsers.filter((id) => id !== userId);

        if (updatedQueryUsers.length === 0) {
            // No more users monitoring this query, delete the query key entirely
            await keyv.delete(queryKey);
            // Remove from global queries tracking
            await removeFromGlobalQueries(subToDelete.query);
        } else {
            // Update query subscribers
            await keyv.set(queryKey, updatedQueryUsers);
        }

        return {
            success: true,
            deletedQuery: subToDelete.query,
            message: `✅ Stopped monitoring "${subToDelete.query}"`,
        };
    } catch (error) {
        console.error('Error deleting subscription:', error);
        return { success: false, message: '❌ Failed to delete subscription. Try again later.' };
    }
}
