import { Category } from '@discordx/utilities';
import {
    ButtonBuilder,
    type ButtonInteraction,
    ButtonStyle,
    type CommandInteraction,
    ContainerBuilder,
    MessageFlags,
    SectionBuilder,
    TextDisplayBuilder,
} from 'discord.js';
import { ButtonComponent, Discord, Slash } from 'discordx';
import { deleteSubscription, keyv } from '../../utils/Util.js';

@Discord()
@Category('Sub')
export class List {
    private static readonly PAGE_SIZE: number = 6;

    private async fetchUserSubs(
        guildId: string,
        userId: string
    ): Promise<Array<{ id: string; query: string; created: number }>> {
        const userKey = `user:${guildId}:${userId}`;
        const subs: Array<{ id: string; query: string; created: number }> =
            ((await keyv.get(userKey)) as Array<{ id: string; query: string; created: number }>) ||
            [];
        return subs;
    }

    private buildPageContainer(
        guildId: string,
        userId: string,
        subs: Array<{ id: string; query: string; created: number }>,
        pageIndex: number
    ): ContainerBuilder {
        const totalPages = Math.max(1, Math.ceil(subs.length / List.PAGE_SIZE));
        const clampedPage = Math.min(Math.max(0, pageIndex), totalPages - 1);
        const start = clampedPage * List.PAGE_SIZE;
        const pageItems = subs.slice(start, start + List.PAGE_SIZE);

        const header = new TextDisplayBuilder().setContent(
            [
                `## 📋 **Your Subscriptions (${subs.length})**`,
                '',
                totalPages > 1 ? `> Page: ${clampedPage + 1}/${totalPages}` : '',
            ].join('\n')
        );

        const container = new ContainerBuilder().addTextDisplayComponents(header);

        // Item sections with inline Remove accessory
        for (const sub of pageItems) {
            const line = new TextDisplayBuilder().setContent(
                `🔎 \`${sub.query}\` • <t:${Math.floor(sub.created / 1000)}:R>`
            );

            const removeBtn = new ButtonBuilder()
                .setCustomId(`subs:list:rm:${guildId}:${userId}:${sub.id}:${clampedPage}`)
                .setLabel('Remove')
                .setStyle(ButtonStyle.Danger);

            const section = new SectionBuilder()
                .addTextDisplayComponents(line)
                .setButtonAccessory(removeBtn);

            container.addSectionComponents(section);
        }

        // Navigation row (only show if more than one page)
        if (totalPages > 1) {
            const prevBtn = new ButtonBuilder()
                .setCustomId(
                    `subs:list:nav:prev:${guildId}:${userId}:${Math.max(clampedPage - 1, 0)}`
                )
                .setLabel('Prev')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(clampedPage === 0);

            const homeBtn = new ButtonBuilder()
                .setCustomId(`subs:list:nav:home:${guildId}:${userId}:0`)
                .setLabel('Home')
                .setStyle(ButtonStyle.Primary)
                .setDisabled(clampedPage === 0);

            const nextBtn = new ButtonBuilder()
                .setCustomId(
                    `subs:list:nav:next:${guildId}:${userId}:${Math.min(clampedPage + 1, totalPages - 1)}`
                )
                .setLabel('Next')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(clampedPage >= totalPages - 1 || subs.length === 0);

            container.addActionRowComponents((row) => row.addComponents(prevBtn, homeBtn, nextBtn));
        }

        return container;
    }

    @Slash({ description: 'List your monitored queries' })
    async list(interaction: CommandInteraction): Promise<void> {
        await interaction.deferReply();
        if (!interaction.guildId) {
            await interaction.editReply('❌ This command can only be used in a server.');
            return;
        }
        const guildId = interaction.guildId;
        const userId = interaction.user.id;
        const subs = await this.fetchUserSubs(guildId, userId);
        const container = this.buildPageContainer(guildId, userId, subs, 0);
        await interaction.editReply({
            components: [container],
            flags: MessageFlags.IsComponentsV2,
        });
    }

    @ButtonComponent({ id: /^subs:list:nav:.+$/ })
    async onNavigate(interaction: ButtonInteraction): Promise<void> {
        const parts = interaction.customId.split(':');
        // New format: ['subs','list','nav','<dir>','<guildId>','<userId>','<page>']
        if (parts.length < 7) {
            await interaction.update({
                components: [
                    new ContainerBuilder().addTextDisplayComponents(
                        new TextDisplayBuilder().setContent('❌ Invalid navigation data.')
                    ),
                ],
                flags: MessageFlags.IsComponentsV2,
            });
            return;
        }

        const guildId = parts[4]!;
        const ownerId = parts[5]!;
        const pageStr = parts[6]!;
        const requestedBy = interaction.user.id;
        if (ownerId !== requestedBy) {
            await interaction.update({
                components: [
                    new ContainerBuilder().addTextDisplayComponents(
                        new TextDisplayBuilder().setContent(
                            '❌ You can only control your own list.'
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
                            '❌ This list can only be controlled in the same server.'
                        )
                    ),
                ],
                flags: MessageFlags.IsComponentsV2,
            });
            return;
        }

        const page = Number.parseInt(pageStr, 10);
        const subs = await this.fetchUserSubs(guildId, ownerId);
        const container = this.buildPageContainer(
            guildId,
            ownerId,
            subs,
            Number.isNaN(page) ? 0 : page
        );
        await interaction.update({ components: [container], flags: MessageFlags.IsComponentsV2 });
    }

    @ButtonComponent({ id: /^subs:list:rm:.+$/ })
    async onRemove(interaction: ButtonInteraction): Promise<void> {
        const parts = interaction.customId.split(':');
        // ['subs','list','rm','<guildId>','<userId>','<subId>','<page>']
        const guildId = parts[3]!;
        const ownerId = parts[4]!;
        const subId = parts[5]!;
        const page = Number.parseInt(parts[6]!, 10) || 0;

        if (ownerId !== interaction.user.id) {
            await interaction.update({
                components: [
                    new ContainerBuilder().addTextDisplayComponents(
                        new TextDisplayBuilder().setContent(
                            '❌ You can only remove your own subscriptions.'
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
                            '❌ This remove action must be used in the same server.'
                        )
                    ),
                ],
                flags: MessageFlags.IsComponentsV2,
            });
            return;
        }

        const result = await deleteSubscription(guildId, ownerId, subId);
        const subs = await this.fetchUserSubs(guildId, ownerId);
        const lastPage = Math.max(0, Math.ceil(subs.length / List.PAGE_SIZE) - 1);
        const targetPage = Math.min(page, lastPage);
        const container = this.buildPageContainer(guildId, ownerId, subs, targetPage);

        await interaction.update({ components: [container], flags: MessageFlags.IsComponentsV2 });

        // Informational ephemeral follow-up
        await interaction.followUp({
            content: result.success ? '✅ Subscription removed.' : `❌ ${result.message}`,
            ephemeral: true,
        });
    }
}
