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
import { ButtonComponent, Discord, Slash, SlashOption } from 'discordx';
import { config } from '../../config/Config.js';
import { keyv } from '../../utils/Util.js';

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

            // Update query subscriptions (for WebSocket lookups)
            const queryUsers: string[] = (await keyv.get(queryKey)) || [];
            if (!queryUsers.includes(userId)) {
                queryUsers.push(userId);
                await keyv.set(queryKey, queryUsers);
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
        userId: string,
        subscriptionId: string,
        userSubsLength: number
    ): ContainerBuilder {
        const countText =
            config.MAX_SUBSCRIPTIONS_PER_USER === 0
                ? 'Unlimited'
                : `${userSubsLength}/${config.MAX_SUBSCRIPTIONS_PER_USER}`;

        const text = new TextDisplayBuilder().setContent(
            [
                '## ✅ **Subscription Added**',
                '',
                `> 🔎 **Query:** ${query}`,
                `> 👤 **User:** <@${userId}>`,
                `> 📦 **Your total subs:** ${countText}`,
            ].join('\n')
        );

        const listBtn = new ButtonBuilder()
            .setCustomId('subs:list')
            .setLabel('List My Subs')
            .setStyle(ButtonStyle.Primary);

        const undoBtn = new ButtonBuilder()
            .setCustomId(`subs:undo:${subscriptionId}`)
            .setLabel('Undo')
            .setStyle(ButtonStyle.Secondary);

        return new ContainerBuilder()
            .addTextDisplayComponents(text)
            .addActionRowComponents((row) => row.addComponents(listBtn, undoBtn));
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
        interaction: CommandInteraction
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

            // Check for similar queries (partial matches)
            const queryWords = query.toLowerCase().split(/\s+/);
            const similarSubs = userSubs.filter((sub) => {
                const subWords = sub.query.toLowerCase().split(/\s+/);
                // Check if any word from the new query is in existing subscriptions
                return queryWords.some(
                    (word) =>
                        word.length >= 3 &&
                        subWords.some((subWord) => subWord.includes(word) || word.includes(subWord))
                );
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

                // Store confirmation data temporarily with short ID
                const confirmId = `${userId}-${Date.now()}`;
                await keyv.set(
                    `confirm:${confirmId}`,
                    { query, userId, subscriptionId, queryKey, userKey },
                    300_000
                ); // 5 min TTL

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
                userId,
                subscriptionId,
                result.userSubs!.length
            );

            await interaction.editReply({
                components: [container],
                flags: MessageFlags.IsComponentsV2,
            });
        } catch (error) {
            console.error('Error adding subscription:', error);
            await interaction.editReply('❌ Failed to add subscription. Try again later.');
        }
    }

    @ButtonComponent({ id: /^subs:confirm:.+$/ })
    async confirm(interaction: ButtonInteraction) {
        const confirmId = interaction.customId.split(':')[2];

        // Get stored confirmation data
        const confirmData = await keyv.get(`confirm:${confirmId}`);
        if (!confirmData) {
            await interaction.update({
                components: [
                    new ContainerBuilder().addTextDisplayComponents(
                        new TextDisplayBuilder().setContent(
                            '❌ Confirmation expired. Please try again.'
                        )
                    ),
                ],
                flags: MessageFlags.IsComponentsV2,
            });
            return;
        }

        const { query, userId, subscriptionId, queryKey, userKey } = confirmData;

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

        // Clean up confirmation data
        await keyv.delete(`confirm:${confirmId}`);

        // Create success message using helper function
        const container = this.createSuccessMessage(
            query,
            userId,
            subscriptionId,
            result.userSubs!.length
        );

        await interaction.update({
            components: [container],
            flags: MessageFlags.IsComponentsV2,
        });
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
