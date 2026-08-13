import { Category } from '@discordx/utilities';
import {
    ApplicationCommandOptionType,
    ButtonBuilder,
    type ButtonInteraction,
    ButtonStyle,
    type CommandInteraction,
    ContainerBuilder,
    MessageFlags,
    TextDisplayBuilder,
} from 'discord.js';
import { ButtonComponent, type Client, Discord, Slash, SlashOption } from 'discordx';
import { config } from '../../config/Config.js';
import {
    addQuerySubscriber,
    areWatchQueriesSimilar,
    deleteSubscription,
    getAlertsChannelForGuild,
    handleError,
    isWatchQueryUsable,
    keyv,
    parseWatchQuery,
} from '../../utils/Util.js';

interface Subscription {
    created: number;
    id: string;
    query: string;
}

@Discord()
@Category('Sub')
export class Add {
    /**
     * Helper function to create a subscription
     */
    private async createSubscription(data: {
        guildId: string;
        query: string;
        userId: string;
        subscriptionId: string;
        userKey: string;
    }): Promise<{ success: boolean; message?: string; userSubs?: Subscription[] }> {
        const { guildId, query, userId, subscriptionId, userKey } = data;
        try {
            // Get existing user subscriptions
            const userSubs: Subscription[] = (await keyv.get(userKey)) || [];

            // Create new subscription
            const newSub: Subscription = {
                created: Date.now(),
                id: subscriptionId,
                query,
            };

            // Update user subscriptions
            userSubs.push(newSub);
            await keyv.set(userKey, userSubs);
            await addQuerySubscriber(guildId, query, userId);

            return { success: true, userSubs };
        } catch (error) {
            console.error('Error creating subscription:', error);
            return { message: '❌ Failed to add subscription. Try again later.', success: false };
        }
    }

    /**
     * Resolves where alerts are sent for display
     */
    private async getNotificationLocationText(guildId: string | null): Promise<string> {
        const channelId = guildId ? await getAlertsChannelForGuild(guildId) : undefined;
        if (channelId) {
            return `> 📍 **Alerts sent to:** <#${channelId}>`;
        }
        return [
            '> 📍 **Alerts sent to:** *No channel set for this server.*',
            '> ⚠️ Ask an admin to run **/setalertschannel** so release alerts are posted here.',
        ].join('\n');
    }

    /**
     * Helper function to create success message components
     */
    private createSuccessMessage(
        guildId: string,
        query: string,
        subscriptionId: string,
        userSubsLength: number,
        notificationLocationText: string
    ): ContainerBuilder {
        const countText =
            config.MAX_SUBSCRIPTIONS_PER_USER === 0
                ? false
                : `${userSubsLength}/${config.MAX_SUBSCRIPTIONS_PER_USER}`;

        const text = new TextDisplayBuilder().setContent(
            [
                '## ✅ **Subscription Added**',
                '',
                `> 🔎 **Query:** ${query}`,
                countText ? `> 📦 **Your total subs:** ${countText}` : '',
                notificationLocationText,
            ]
                .filter(Boolean)
                .join('\n')
        );

        const undoBtn = new ButtonBuilder()
            .setCustomId(`subs:undo:${guildId}:${subscriptionId}`)
            .setLabel('Undo')
            .setStyle(ButtonStyle.Secondary);

        return new ContainerBuilder()
            .addTextDisplayComponents(text)
            .addActionRowComponents((row) => row.addComponents(undoBtn));
    }
    @Slash({ description: 'Add a scene query to monitor (tokens, team:, cat:, quotes)' })
    async add(
        @SlashOption({
            description: 'e.g. breaking bad 1080p  |  team:SPARKS  |  "breaking.bad" cat:X264',
            maxLength: 50,
            minLength: 4,
            name: 'query',
            required: true,
            type: ApplicationCommandOptionType.String,
        })
        query: string,
        interaction: CommandInteraction,
        client: Client
    ) {
        await interaction.deferReply();

        if (!interaction.guildId) {
            await interaction.editReply('❌ This command can only be used in a server.');
            return;
        }

        const { guildId } = interaction;
        const userId = interaction.user.id;
        const subscriptionId = `${userId}-${Date.now()}`;
        const userKey = `user:${guildId}:${userId}`;

        try {
            // Get existing user subscriptions
            const userSubs: Subscription[] = (await keyv.get(userKey)) || [];

            // Check if already subscribed to this query
            if (userSubs.some((sub) => sub.query.toLowerCase() === query.toLowerCase())) {
                await interaction.editReply(`❌ You're already monitoring "${query}"`);
                return;
            }

            const parsedQuery = parseWatchQuery(query);
            if (!isWatchQueryUsable(parsedQuery)) {
                await interaction.editReply(
                    '❌ Query has nothing to match. Use title tokens, `team:GROUP`, `cat:CATEGORY`, or a quoted phrase.'
                );
                return;
            }

            const similarSubs = userSubs.filter((sub) => areWatchQueriesSimilar(query, sub.query));

            if (similarSubs.length > 0) {
                const similarQueries = similarSubs.map((sub) => `"${sub.query}"`).join(', ');

                const confirmText = new TextDisplayBuilder().setContent(
                    [
                        '## ⚠️ **Similar Subscription Found**',
                        '',
                        `> 🔎 **New query:** \`${query}\``,
                        `> 📋 **Similar existing:** \`${similarQueries}\``,
                        '',
                        '> You already monitor similar search terms. Continue anyway?',
                    ].join('\n')
                );

                // Build compact customId
                const encodedQuery = query.trim();
                const qEnc = encodeURIComponent(encodedQuery);
                const confirmId = `${guildId}:${userId}:${qEnc}`;

                const continueBtn = new ButtonBuilder()
                    .setCustomId(`subs:confirm:${confirmId}`)
                    .setLabel('Yes')
                    .setStyle(ButtonStyle.Success);

                const cancelBtn = new ButtonBuilder()
                    .setCustomId('subs:cancel')
                    .setLabel('Cancel')
                    .setStyle(ButtonStyle.Secondary);

                const confirmContainer = new ContainerBuilder()
                    .addTextDisplayComponents(confirmText)
                    .addActionRowComponents((row) => row.addComponents(continueBtn, cancelBtn));

                await interaction.editReply({
                    components: [confirmContainer],
                    flags: MessageFlags.IsComponentsV2,
                });
                return;
            }

            // Check subscription limit (0 = unlimited)
            if (
                config.MAX_SUBSCRIPTIONS_PER_USER !== 0 &&
                userSubs.length >= config.MAX_SUBSCRIPTIONS_PER_USER
            ) {
                await interaction.editReply(
                    `❌ Maximum ${config.MAX_SUBSCRIPTIONS_PER_USER} subscriptions per user. Remove some first.`
                );
                return;
            }

            // Create the subscription using helper function
            const result = await this.createSubscription({
                guildId,
                query,
                subscriptionId,
                userId,
                userKey,
            });

            if (!result.success) {
                await interaction.editReply(result.message!);
                return;
            }

            // Create success message using helper function
            const locationText = await this.getNotificationLocationText(
                interaction.guildId ?? null
            );
            const container = this.createSuccessMessage(
                guildId,
                query,
                subscriptionId,
                result.userSubs!.length,
                locationText
            );

            await interaction.editReply({
                components: [container],
                flags: MessageFlags.IsComponentsV2,
            });
        } catch (error) {
            console.error('Error adding subscription');
            await handleError(client, error);
            await interaction.editReply('❌ Failed to add subscription. Try again later.');
        }
    }

    @ButtonComponent({ id: /^subs:confirm:.+$/ })
    async confirm(interaction: ButtonInteraction) {
        const parts = interaction.customId.split(':');
        // Format: ['subs','confirm','<guildId>','<userId>','<qEnc>']
        if (parts.length < 5) {
            await interaction.update({
                components: [
                    new ContainerBuilder().addTextDisplayComponents(
                        new TextDisplayBuilder().setContent('❌ Invalid confirmation data.')
                    ),
                ],
                flags: MessageFlags.IsComponentsV2,
            });
            return;
        }

        const guildId = parts[2]!;
        const userId = parts[3]!;
        const qEnc = parts.slice(4).join(':');
        const query = decodeURIComponent(qEnc);

        // Verify ownership
        if (userId !== interaction.user.id) {
            await interaction.update({
                components: [
                    new ContainerBuilder().addTextDisplayComponents(
                        new TextDisplayBuilder().setContent(
                            '❌ You can only confirm your own subscriptions.'
                        )
                    ),
                ],
                flags: MessageFlags.IsComponentsV2,
            });
            return;
        }
        if (interaction.guildId !== guildId) {
            await interaction.update({
                components: [
                    new ContainerBuilder().addTextDisplayComponents(
                        new TextDisplayBuilder().setContent(
                            '❌ This confirmation must be used in the same server.'
                        )
                    ),
                ],
                flags: MessageFlags.IsComponentsV2,
            });
            return;
        }

        // Reconstruct values
        const subscriptionId = `${userId}-${Date.now()}`;
        const userKey = `user:${guildId}:${userId}`;

        // Create the subscription using helper function
        const result = await this.createSubscription({
            guildId,
            query,
            subscriptionId,
            userId,
            userKey,
        });

        if (!result.success) {
            await interaction.update({
                components: [
                    new ContainerBuilder().addTextDisplayComponents(
                        new TextDisplayBuilder().setContent(result.message!)
                    ),
                ],
                flags: MessageFlags.IsComponentsV2,
            });
            return;
        }

        // Create success message using helper function
        const locationText = await this.getNotificationLocationText(interaction.guildId ?? null);
        const container = this.createSuccessMessage(
            guildId,
            query,
            subscriptionId,
            result.userSubs!.length,
            locationText
        );

        await interaction.update({
            components: [container],
            flags: MessageFlags.IsComponentsV2,
        });
    }

    @ButtonComponent({ id: /^subs:undo:.+$/ })
    async undo(interaction: ButtonInteraction) {
        const parts = interaction.customId.split(':');
        const guildId = parts[2] || interaction.guildId;
        const subscriptionId = parts[3] || parts[2];
        const userId = interaction.user.id;

        if (!guildId) {
            const errorText = new TextDisplayBuilder().setContent(
                ['## ❌ **Invalid Request**', '', '> This action must be used in a server.'].join(
                    '\n'
                )
            );
            await interaction.update({
                components: [new ContainerBuilder().addTextDisplayComponents(errorText)],
                flags: MessageFlags.IsComponentsV2,
            });
            return;
        }

        // Validate subscription ID format
        if (!subscriptionId?.includes('-')) {
            const errorText = new TextDisplayBuilder().setContent(
                ['## ❌ **Invalid Request**', '', '> Malformed subscription ID.'].join('\n')
            );
            await interaction.update({
                components: [new ContainerBuilder().addTextDisplayComponents(errorText)],
                flags: MessageFlags.IsComponentsV2,
            });
            return;
        }

        // Extract user ID from subscription ID to verify ownership
        const [subscriptionUserId] = subscriptionId.split('-');
        if (subscriptionUserId !== userId) {
            const errorText = new TextDisplayBuilder().setContent(
                ['## ❌ **Access Denied**', '', '> You can only undo your own subscriptions.'].join(
                    '\n'
                )
            );
            await interaction.update({
                components: [new ContainerBuilder().addTextDisplayComponents(errorText)],
                flags: MessageFlags.IsComponentsV2,
            });
            return;
        }

        // Delete the subscription using utility function
        const result = await deleteSubscription(guildId, userId, subscriptionId);

        if (result.success) {
            const undoText = new TextDisplayBuilder().setContent(
                [
                    '## ↩️ **Subscription Removed**',
                    '',
                    `> 🔎 **Query:** ${result.deletedQuery}`,
                    `> 👤 **User:** <@${userId}>`,
                    '',
                    '> Subscription has been successfully removed.',
                ].join('\n')
            );

            const undoContainer = new ContainerBuilder().addTextDisplayComponents(undoText);

            await interaction.update({
                components: [undoContainer],
                flags: MessageFlags.IsComponentsV2,
            });
        } else {
            const errorText = new TextDisplayBuilder().setContent(
                ['## ❌ **Undo Failed**', '', `> ${result.message}`].join('\n')
            );

            const errorContainer = new ContainerBuilder().addTextDisplayComponents(errorText);

            await interaction.update({
                components: [errorContainer],
                flags: MessageFlags.IsComponentsV2,
            });
        }
    }

    @ButtonComponent({ id: 'subs:cancel' })
    async cancel(interaction: ButtonInteraction) {
        const cancelText = new TextDisplayBuilder().setContent(
            [
                '## ❌ **Subscription Cancelled**',
                '',
                '> Operation was cancelled. No subscription was added.',
            ].join('\n')
        );

        const cancelContainer = new ContainerBuilder().addTextDisplayComponents(cancelText);

        await interaction.update({
            components: [cancelContainer],
            flags: MessageFlags.IsComponentsV2,
        });
    }
}
