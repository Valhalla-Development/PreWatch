import { Category } from '@discordx/utilities';
import {
    ApplicationCommandOptionType,
    ButtonBuilder,
    ButtonStyle,
    type CommandInteraction,
    ContainerBuilder,
    MessageFlags,
    TextDisplayBuilder,
} from 'discord.js';
import { Discord, Slash, SlashOption } from 'discordx';
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

            // Fancy confirmation using components
            const countText =
                config.MAX_SUBSCRIPTIONS_PER_USER === 0
                    ? 'Unlimited'
                    : `${userSubs.length}/${config.MAX_SUBSCRIPTIONS_PER_USER}`;

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

            const container = new ContainerBuilder()
                .addTextDisplayComponents(text)
                .addActionRowComponents((row) => row.addComponents(listBtn, undoBtn));

            await interaction.editReply({
                components: [container],
                flags: MessageFlags.IsComponentsV2,
            });
        } catch (error) {
            console.error('Error adding subscription:', error);
            await interaction.editReply('❌ Failed to add subscription. Try again later.');
        }
    }
}
