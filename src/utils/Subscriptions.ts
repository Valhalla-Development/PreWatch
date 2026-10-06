import { createHash } from 'node:crypto';
import type { Client } from 'discordx';
import { log } from './Console.js';
import { parseWatchQuery } from './Match.js';
import { keyv } from './Store.js';
import type { ActiveSubscription, LastSeen, ParsedWatchQuery, Release } from './Types.js';

export function normalizeQueryStorageKey(query: string): string {
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
    const existing = await getLastSeenForGuildQuery(guildId, query);
    const payload: LastSeen = {
        ...existing,
        id: release.id,
        pollPreAt: existing.pollPreAt ?? existing.preAt ?? release.preAt,
        preAt: Math.max(existing.preAt ?? 0, release.preAt),
    };
    // Individual receipts keep out-of-order and same-second releases independent.
    await keyv.set(getDeliveryKey(guildId, query, release.id), true, 7 * 24 * 60 * 60 * 1000);
    await keyv.set(key, payload);
    lastSeenCache.set(key, payload);
}

async function seedLastSeenIfAbsentUnlocked(
    guildId: string,
    query: string,
    preAt: number
): Promise<void> {
    const existing = await getLastSeenForGuildQuery(guildId, query);
    if (typeof existing.preAt === 'number') {
        return;
    }
    const key = getLastSeenKey(guildId, query);
    const payload: LastSeen = { pollPreAt: preAt, preAt, startedAt: preAt };
    await keyv.set(key, payload);
    lastSeenCache.set(key, payload);
}

export function seedLastSeenIfAbsent(guildId: string, query: string, preAt: number): Promise<void> {
    return withLastSeenLock(guildId, query, () =>
        seedLastSeenIfAbsentUnlocked(guildId, query, preAt)
    );
}

const lastSeenLocks = new Map<string, Promise<void>>();

export function withLastSeenLock<T>(
    guildId: string,
    query: string,
    fn: () => Promise<T>
): Promise<T> {
    const key = getLastSeenKey(guildId, query);
    const previous = lastSeenLocks.get(key) ?? Promise.resolve();
    const run = previous.then(fn);
    const settled = run.then(
        () => undefined,
        () => undefined
    );
    lastSeenLocks.set(key, settled);
    settled.then(() => {
        if (lastSeenLocks.get(key) === settled) {
            lastSeenLocks.delete(key);
        }
    });
    return run;
}

export function isAlreadySeen(lastSeen: LastSeen, release: Release): boolean {
    return (
        lastSeen.id === release.id ||
        (typeof lastSeen.startedAt === 'number' && release.preAt < lastSeen.startedAt)
    );
}

function getDeliveryKey(guildId: string, query: string, releaseId: number): string {
    return `delivered:${guildId}:${normalizeQueryStorageKey(query)}:${releaseId}`;
}

export async function isReleaseDelivered(
    guildId: string,
    query: string,
    release: Release
): Promise<boolean> {
    const lastSeen = await getLastSeenForGuildQuery(guildId, query);
    return (
        isAlreadySeen(lastSeen, release) ||
        Boolean(await keyv.get(getDeliveryKey(guildId, query, release.id)))
    );
}

export async function advancePollCursor(
    guildId: string,
    query: string,
    preAt: number
): Promise<void> {
    await withLastSeenLock(guildId, query, async () => {
        const existing = await getLastSeenForGuildQuery(guildId, query);
        const payload: LastSeen = {
            ...existing,
            pollPreAt: Math.max(existing.pollPreAt ?? 0, preAt),
        };
        await keyv.set(getLastSeenKey(guildId, query), payload);
        lastSeenCache.set(getLastSeenKey(guildId, query), payload);
    });
}

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

export function getIndexedQueryWatchers(client: Client, query: string): string[] {
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

export function getPollQueries(client: Client): Promise<string[]> {
    if (indexHydrated) {
        return Promise.resolve(getIndexedPollQueries(client));
    }
    return loadPollQueriesFromKeyv(client);
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

export async function rebuildSubscriptionIndex(client: Client): Promise<void> {
    subscriptionIndex.clear();
    alertsChannelByGuild.clear();
    lastSeenCache.clear();
    indexHydrated = false;

    await Promise.all(Array.from(client.guilds.cache.keys(), (guildId) => indexLoadGuild(guildId)));
    indexHydrated = true;

    const subscriptions = readSubscriptionsFromIndex(client);
    log.ok(
        `[INDEX] Loaded ${subscriptions.length} watches across ${subscriptionIndex.size} guilds`
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

async function addToGlobalQueries(guildId: string, query: string): Promise<void> {
    const allQueriesKey = `meta:all_queries:${guildId}`;
    const allQueries: string[] = (await keyv.get(allQueriesKey)) || [];

    if (
        !allQueries.some(
            (existing) => normalizeQueryStorageKey(existing) === normalizeQueryStorageKey(query)
        )
    ) {
        allQueries.push(query);
        await keyv.set(allQueriesKey, allQueries);
    }
}

async function addQuerySubscriberUnlocked(
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
    await seedLastSeenIfAbsent(guildId, query, Math.floor(Date.now() / 1000));
    indexAddUser(guildId, query, userId);
}

async function removeFromGlobalQueries(guildId: string, query: string): Promise<void> {
    const allQueriesKey = `meta:all_queries:${guildId}`;
    const allQueries: string[] = (await keyv.get(allQueriesKey)) || [];

    const updatedQueries = allQueries.filter(
        (q) => normalizeQueryStorageKey(q) !== normalizeQueryStorageKey(query)
    );

    if (updatedQueries.length === 0) {
        await keyv.delete(allQueriesKey);
    } else {
        await keyv.set(allQueriesKey, updatedQueries);
    }
}

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
        const userSubs: Array<{ id: string; query: string; created: number }> =
            (await keyv.get(userKey)) || [];

        const matchingSubs = userSubs.filter(
            (sub) => normalizeQueryStorageKey(sub.query) === normalizeQueryStorageKey(query)
        );
        if (matchingSubs.length === 0) {
            return { message: '❌ You are not subscribed to this query.', success: false };
        }

        const result = await deleteSubscription(guildId, userId, matchingSubs[0]!.id);

        if (result.success) {
            return {
                message: `✅ Unsubscribed from "${query}"`,
                success: true,
            };
        }

        return result;
    } catch (error) {
        log.error('Failed to unsubscribe from query', error);
        return { message: '❌ Failed to unsubscribe. Try again later.', success: false };
    }
}

async function deleteSubscriptionUnlocked(
    guildId: string,
    userId: string,
    subscriptionId: string
): Promise<{
    success: boolean;
    message?: string;
    deletedQuery?: string;
}> {
    const userKey = `user:${guildId}:${userId}`;
    const userSubs: Array<{ id: string; query: string; created: number }> =
        (await keyv.get(userKey)) || [];

    const subToDelete = userSubs.find((sub) => sub.id === subscriptionId);
    if (!subToDelete) {
        return { message: '❌ Subscription not found.', success: false };
    }

    const updatedUserSubs = userSubs.filter((sub) => sub.id !== subscriptionId);

    if (updatedUserSubs.length === 0) {
        await keyv.delete(userKey);
    } else {
        await keyv.set(userKey, updatedUserSubs);
    }

    const queryKey = `query:${guildId}:${normalizeQueryStorageKey(subToDelete.query)}`;
    const queryUsers: string[] = (await keyv.get(queryKey)) || [];
    const stillSubscribed = updatedUserSubs.some(
        (sub) => normalizeQueryStorageKey(sub.query) === normalizeQueryStorageKey(subToDelete.query)
    );
    const updatedQueryUsers = stillSubscribed
        ? queryUsers
        : queryUsers.filter((id) => id !== userId);

    if (updatedQueryUsers.length === 0) {
        await keyv.delete(queryKey);
        await removeFromGlobalQueries(guildId, subToDelete.query);
    } else {
        await keyv.set(queryKey, updatedQueryUsers);
    }

    if (!stillSubscribed) {
        indexRemoveUser(guildId, subToDelete.query, userId);
    }

    return {
        deletedQuery: subToDelete.query,
        message: `✅ Stopped monitoring "${subToDelete.query}"`,
        success: true,
    };
}

const subscriptionLocks = new Map<string, Promise<void>>();

// Discord routes a guild to one cluster. Serialize its related storage mutations there.
function withSubscriptionLock<T>(guildId: string, fn: () => Promise<T>): Promise<T> {
    const previous = subscriptionLocks.get(guildId) ?? Promise.resolve();
    const run = previous.then(fn);
    const settled = run.then(
        () => undefined,
        () => undefined
    );
    subscriptionLocks.set(guildId, settled);
    settled.then(() => {
        if (subscriptionLocks.get(guildId) === settled) {
            subscriptionLocks.delete(guildId);
        }
    });
    return run;
}

// Keyv has no multi-key transaction API. Restore the original records on a failed mutation.
async function withSubscriptionRollback<T>(keys: string[], fn: () => Promise<T>): Promise<T> {
    const originals = await Promise.all(keys.map((key) => keyv.get(key)));
    try {
        return await fn();
    } catch (error) {
        await Promise.all(
            keys.map(async (key, index) => {
                lastSeenCache.delete(key);
                if (originals[index] === undefined) {
                    await keyv.delete(key);
                } else {
                    await keyv.set(key, originals[index]);
                }
            })
        );
        throw error;
    }
}

function subscriptionKeys(guildId: string, query: string, userId?: string): string[] {
    return [
        ...(userId ? [`user:${guildId}:${userId}`] : []),
        `query:${guildId}:${normalizeQueryStorageKey(query)}`,
        `meta:all_queries:${guildId}`,
    ];
}

export interface StoredSubscription {
    created: number;
    id: string;
    query: string;
}

export function createStoredSubscription(data: {
    guildId: string;
    query: string;
    userId: string;
    subscriptionId: string;
    limit: number;
}): Promise<{ success: boolean; message?: string; userSubs?: StoredSubscription[] }> {
    const { guildId, query, userId, subscriptionId, limit } = data;
    return withSubscriptionLock(guildId, async () => {
        const userKey = `user:${guildId}:${userId}`;
        const userSubs: StoredSubscription[] = (await keyv.get(userKey)) || [];
        if (
            userSubs.some(
                (sub) => normalizeQueryStorageKey(sub.query) === normalizeQueryStorageKey(query)
            )
        ) {
            return { message: `❌ You're already monitoring "${query}"`, success: false };
        }
        if (limit > 0 && userSubs.length >= limit) {
            return {
                message: `❌ Maximum ${limit} subscriptions per user. Remove some first.`,
                success: false,
            };
        }
        return withSubscriptionRollback(subscriptionKeys(guildId, query, userId), async () => {
            const updated = [...userSubs, { created: Date.now(), id: subscriptionId, query }];
            await keyv.set(userKey, updated);
            await addQuerySubscriberUnlocked(guildId, query, userId);
            return { success: true, userSubs: updated };
        });
    });
}

export function addQuerySubscriber(guildId: string, query: string, userId: string): Promise<void> {
    return withSubscriptionLock(guildId, () =>
        withSubscriptionRollback(subscriptionKeys(guildId, query), () =>
            addQuerySubscriberUnlocked(guildId, query, userId)
        )
    );
}

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
        return await withSubscriptionLock(guildId, async () => {
            const subs: StoredSubscription[] = (await keyv.get(`user:${guildId}:${userId}`)) || [];
            const sub = subs.find((entry) => entry.id === subscriptionId);
            if (!sub) {
                return { message: '❌ Subscription not found.', success: false };
            }
            return withSubscriptionRollback(subscriptionKeys(guildId, sub.query, userId), () =>
                deleteSubscriptionUnlocked(guildId, userId, subscriptionId)
            );
        });
    } catch (error) {
        log.error('Failed to delete subscription', error);
        return { message: '❌ Failed to delete subscription. Try again later.', success: false };
    }
}

export function getQueryToken(query: string): string {
    return createHash('sha256').update(normalizeQueryStorageKey(query)).digest('hex').slice(0, 24);
}

export async function unsubscribeFromQueryToken(
    userId: string,
    guildId: string,
    token: string
): Promise<{
    success: boolean;
    message?: string;
}> {
    const subs: StoredSubscription[] = (await keyv.get(`user:${guildId}:${userId}`)) || [];
    const sub = subs.find((entry) => getQueryToken(entry.query) === token);
    if (!sub) {
        return { message: '❌ You are not subscribed to this query.', success: false };
    }
    return unsubscribeFromQuery(userId, guildId, sub.query);
}
