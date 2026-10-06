import {
    ButtonBuilder,
    ButtonStyle,
    ContainerBuilder,
    DiscordAPIError,
    MessageFlags,
    SeparatorSpacingSize,
    type TextChannel,
    TextDisplayBuilder,
} from 'discord.js';
import type { Client } from 'discordx';
import { log } from './Console.js';
import { releaseMatchesParsed } from './Match.js';
import {
    getAllActiveSubscriptions,
    isReleaseDelivered,
    normalizeQueryStorageKey,
    setLastSeenForGuildQuery,
    withLastSeenLock,
} from './Subscriptions.js';
import type { Release, WebSocketMessage } from './Types.js';
import { delay, handleError } from './Util.js';

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

export async function processReleaseNotification(
    client: Client,
    release: WebSocketMessage,
    watchQuery?: string
): Promise<boolean> {
    if (release.action !== 'insert' || !release.row) {
        return true;
    }

    const { row } = release;

    try {
        const subscriptions = await getAllActiveSubscriptions(client);
        const matchedQueries = new Set<string>();
        let succeeded = true;
        const isTestRelease = row.id === 999_999;

        await Promise.all(
            subscriptions.map(async (subscription) => {
                const { guildId, channelId, parsed, query, users } = subscription;

                if (
                    watchQuery &&
                    normalizeQueryStorageKey(watchQuery) !== normalizeQueryStorageKey(query)
                ) {
                    return;
                }
                if (!releaseMatchesParsed(parsed, row)) {
                    return;
                }

                await withLastSeenLock(guildId, query, async () => {
                    const shouldNotify = isTestRelease
                        ? true
                        : !(await isReleaseDelivered(guildId, query, row));

                    if (!shouldNotify) {
                        log.info(`[DEDUPE] Skipping duplicate for query "${query}": ${row.name}`);
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
                        succeeded = false;
                        log.warn(
                            `[NOTIFICATION] Send failed for query "${query}"; lastSeen left unchanged so this release can retry`
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
            log.ok(`[NOTIFICATION] Found ${matchedQueries.size} matching queries for: ${row.name}`);
        }
        return succeeded;
    } catch (error) {
        log.error('[NOTIFICATION] Error processing release', error);
        await handleError(client, error);
        return false;
    }
}

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
            log.error(
                `[NOTIFICATION] Cannot send to channel ${channelId}: missing or not text-based`
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
                log.ok(
                    `[NOTIFICATION] Sent to channel ${channel.id} (${userIdsToPing.length} users)`
                );
                log.ok(
                    `[NOTIFICATION] Notified ${userIdsToPing.length} users about: ${release.name} (query: ${matchedQuery})`
                );
                return true;
            } catch (error) {
                const willRetry = !isNonRetryableSendError(error) && attempt < NOTIFY_SEND_ATTEMPTS;
                log.error(
                    `[NOTIFICATION] Failed to send to channel ${channel.id} (attempt ${attempt}/${NOTIFY_SEND_ATTEMPTS})`,
                    error
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
        log.error('[NOTIFICATION] Error sending batch notification', error);
        await handleError(client, error);
        return false;
    }
}

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

    log.info(`[TEST] Simulating release: ${releaseName}`);
    await processReleaseNotification(client, mockRelease);
}
