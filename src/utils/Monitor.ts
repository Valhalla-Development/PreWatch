import axios from 'axios';
import type { Client } from 'discordx';
import WebSocket from 'ws';
import { config } from '../config/Config.js';
import { log } from './Console.js';
import { pollSearchString } from './Match.js';
import { processReleaseNotification } from './Notify.js';
import {
    getIndexedQueryWatchers,
    getLastSeenForGuildQuery,
    getPollQueries,
    isAlreadySeen,
    seedLastSeenIfAbsent,
} from './Subscriptions.js';
import type { LastSeen, Release, WebSocketMessage } from './Types.js';
import { delay } from './Util.js';

export async function checkApiHealth(): Promise<boolean> {
    try {
        const response = await axios.get(`${config.API_URL}/stats`);

        const isHealthy =
            response.data.status === 'success' &&
            response.data.data &&
            typeof response.data.data.total === 'number' &&
            response.data.data.total > 0;

        if (isHealthy) {
            const totalReleases = response.data.data.total.toLocaleString('en');
            log.ok(`[API STATUS] API is healthy! Total releases: ${totalReleases}`);
        } else {
            log.warn('[API STATUS] API health check failed: Invalid response structure or no data');
        }

        return isHealthy;
    } catch (error) {
        log.error('[API STATUS] API health check failed', error);
        return false;
    }
}

let releaseStreamUp = false;
let pollCatchUpRequested = false;
let wakePollLoop: (() => void) | undefined;

const POLL_PAGE_SIZE = 20;
const POLL_MAX_PAGES = 5;
const POLL_SAFE_REQUESTS_PER_MINUTE = 30;

export function connectToReleaseStream(onMessage: (data: WebSocketMessage) => void): WebSocket {
    const wsUrl = `${config.API_URL}/ws`;
    const ws = new WebSocket(wsUrl);

    const HEARTBEAT_INTERVAL_MS = 30_000;
    let isAlive = true;
    let heartbeat: ReturnType<typeof setInterval> | undefined;

    ws.on('open', () => {
        log.ok('[WEBSOCKET] Connected to real-time release stream');

        isAlive = true;
        releaseStreamUp = true;
        pollCatchUpRequested = true;
        wakePollLoop?.();
        heartbeat = setInterval(() => {
            if (!isAlive) {
                log.warn('[WEBSOCKET] No pong received, terminating stale connection...');
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
        isAlive = true;
        try {
            const release = JSON.parse(data.toString());

            if (release.action === 'insert') {
                log.info(
                    `[WEBSOCKET] Received ${release.action}: ${release.row?.name || 'Unknown'}`
                );
                onMessage(release);
            }
        } catch (error) {
            log.error('[WEBSOCKET] Failed to parse message', error);
        }
    });

    ws.on('error', (error) => {
        log.error('[WEBSOCKET] Connection error', error);
    });

    ws.on('close', (code, reason) => {
        if (heartbeat) {
            clearInterval(heartbeat);
            heartbeat = undefined;
        }

        log.warn(`[WEBSOCKET] Connection closed: ${code} - ${reason}`);

        releaseStreamUp = false;
        wakePollLoop?.();

        setTimeout(() => {
            log.info('[WEBSOCKET] Attempting to reconnect...');
            connectToReleaseStream(onMessage);
        }, 5000);
    });

    return ws;
}

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
                log.error('[POLL] Loop error', error);
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
            const allQueries = await getPollQueries(client);

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
                log.info(
                    `[POLL] Interval set to ${effectiveIntervalSec}s for ${allQueries.length} queries (~${rpm} req/min)`
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
            log.info(`[POLL] Running ${allQueries.length} queries (${reason})`);

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

            log.ok(
                `[POLL] Completed ${allQueries.length} queries in ${(elapsedMs / 1000).toFixed(1)}s, next cycle in ${(nextDelayMs / 1000).toFixed(1)}s`
            );

            schedule(nextDelayMs);
        } catch (error) {
            log.error('[POLL] Loop error', error);
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
                log.warn(
                    `[POLL] Hit ${POLL_MAX_PAGES} page cap for "${search}"; older unseen releases may remain`
                );
            }
        } catch (err) {
            log.warn(`[POLL] Failed page offset ${offset} for "${search}"`, err);
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
        log.warn(`[POLL] Failed query for "${query}"`, err);
    }

    await delay(perRequestDelayMs);
}
