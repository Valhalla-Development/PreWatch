import '@colors/colors';
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
import { releaseMatchesParsed } from './Match.js';
import {
    getAllActiveSubscriptions,
    getLastSeenForGuildQuery,
    isAlreadySeen,
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
