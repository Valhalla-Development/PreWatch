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
import { addToGlobalQueries, deleteSubscription, handleError, keyv } from '../../utils/Util.js';

type Subscription = {
    id: string;
    query: string;
    created: number;
};

@Discord()
@Category('Sub')
export class Add {
    /**
     * Helper function to create a subscription
     */
    private async createSubscription(data: {
        query: string;
        userId: string;
        subscriptionId: string;
        queryKey: string;
        userKey: string;
    }): Promise<{ success: boolean; message?: string; userSubs?: Subscription[] }> {
        const { query, userId, subscriptionId, queryKey, userKey } = data;
        try {
            // Get existing user subscriptions
            const userSubs: Subscription[] = (await keyv.get(userKey)) || [];

            // Create new subscription
            const newSub: Subscription = {
                id: subscriptionId,
                query,
                created: Date.now(),
            };

            // Update user subscriptions
            userSubs.push(newSub);
            await keyv.set(userKey, userSubs);

            // Update query subscriptions
            const queryUsers: string[] = (await keyv.get(queryKey)) || [];
            if (!queryUsers.includes(userId)) {
                queryUsers.push(userId);
                await keyv.set(queryKey, queryUsers);

                // Add to global queries tracking for notifications
                await addToGlobalQueries(query);
            }

            return { success: true, userSubs };
        } catch (error) {
            console.error('Error creating subscription:', error);
            return { success: false, message: '❌ Failed to add subscription. Try again later.' };
        }
    }

    /**
     * Helper function to create success message components
     */
    private createSuccessMessage(
        query: string,
        subscriptionId: string,
        userSubsLength: number
    ): ContainerBuilder {
        const countText =
            config.MAX_SUBSCRIPTIONS_PER_USER !== 0
                ? `${userSubsLength}/${config.MAX_SUBSCRIPTIONS_PER_USER}`
                : false;

        const text = new TextDisplayBuilder().setContent(
            [
                '## ✅ **Subscription Added**',
                '',
                `> 🔎 **Query:** ${query}`,
                countText ? `> 📦 **Your total subs:** ${countText}` : '',
            ].join('\n')
        );

        const undoBtn = new ButtonBuilder()
            .setCustomId(`subs:undo:${subscriptionId}`)
            .setLabel('Undo')
            .setStyle(ButtonStyle.Secondary);

        return new ContainerBuilder()
            .addTextDisplayComponents(text)
            .addActionRowComponents((row) => row.addComponents(undoBtn));
    }
    @Slash({ description: 'Add a query to monitor' })
    async add(
        @SlashOption({
            description: 'Add a query to monitor',
            name: 'query',
            required: true,
            type: ApplicationCommandOptionType.String,
            minLength: 4,
            maxLength: 50,
        })
        query: string,
        interaction: CommandInteraction,
        client: Client
    ) {
        await interaction.deferReply();

        const userId = interaction.user.id;
        const subscriptionId = `${userId}-${Date.now()}`;
        const queryKey = `query:${query.toLowerCase().replace(/\s+/g, '+')}`;
        const userKey = `user:${userId}`;

        try {
            // Get existing user subscriptions
            const userSubs: Subscription[] = (await keyv.get(userKey)) || [];

            // Check if already subscribed to this query
            if (userSubs.some((sub) => sub.query.toLowerCase() === query.toLowerCase())) {
                await interaction.editReply(`❌ You're already monitoring "${query}"`);
                return;
            }

            // Check for similar queries
            const normalizedQuery = query
                .toLowerCase()
                .replace(/[.\-_]/g, ' ')
                .trim();
            const similarSubs = userSubs.filter((sub) => {
                const normalizedSub = sub.query
                    .toLowerCase()
                    .replace(/[.\-_]/g, ' ')
                    .trim();

                // Check for substantial overlap
                const queryWords = normalizedQuery.split(/\s+/).filter((w) => w.length >= 3);
                const subWords = normalizedSub.split(/\s+/).filter((w) => w.length >= 3);

                if (queryWords.length === 0 || subWords.length === 0) {
                    return false;
                }

                const commonWords = queryWords.filter((word) =>
                    subWords.some(
                        (subWord) =>
                            word === subWord ||
                            (word.length >= 5 &&
                                subWord.length >= 5 &&
                                (word.includes(subWord) || subWord.includes(word)))
                    )
                );

                const similarity =
                    commonWords.length / Math.min(queryWords.length, subWords.length);
                return similarity >= 0.6; // 60% similarity threshold
            });

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
                const confirmId = `${userId}:${qEnc}`;

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
                query,
                userId,
                subscriptionId,
                queryKey,
                userKey,
            });

            if (!result.success) {
                await interaction.editReply(result.message!);
                return;
            }

            // Create success message using helper function
            const container = this.createSuccessMessage(
                query,
                subscriptionId,
                result.userSubs!.length
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
        // Format: ['subs','confirm','<userId>','<qEnc>']
        if (parts.length < 4) {
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

        const userId = parts[2]!;
        const qEnc = parts.slice(3).join(':');
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

        // Reconstruct values
        const subscriptionId = `${userId}-${Date.now()}`;
        const queryKey = `query:${query.toLowerCase().replace(/\s+/g, '+')}`;
        const userKey = `user:${userId}`;

        // Create the subscription using helper function
        const result = await this.createSubscription({
            query,
            userId,
            subscriptionId,
            queryKey,
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
        const container = this.createSuccessMessage(query, subscriptionId, result.userSubs!.length);

        await interaction.update({
            components: [container],
            flags: MessageFlags.IsComponentsV2,
        });
    }

    @ButtonComponent({ id: /^subs:undo:.+$/ })
    async undo(interaction: ButtonInteraction) {
        const subscriptionId = interaction.customId.split(':')[2];
        const userId = interaction.user.id;

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
        const subscriptionUserId = subscriptionId.split('-')[0];
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
        const result = await deleteSubscription(userId, subscriptionId);

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
