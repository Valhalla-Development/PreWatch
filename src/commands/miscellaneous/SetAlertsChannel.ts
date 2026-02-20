import { Category } from '@discordx/utilities';
import {
    ChannelSelectMenuBuilder,
    type ChannelSelectMenuInteraction,
    ChannelType,
    type CommandInteraction,
    ContainerBuilder,
    MessageFlags,
    PermissionFlagsBits,
    TextDisplayBuilder,
} from 'discord.js';
import { type Client, Discord, SelectMenuComponent, Slash } from 'discordx';
import { getAlertsChannelForGuild, setAlertsChannelForGuild } from '../../utils/Util.js';

const ALERTS_CHANNEL_SELECT_ID = 'alerts_channel_select';

@Discord()
@Category('Miscellaneous')
export class SetAlertsChannel {
    private static buildChannelSelectMenu(): ChannelSelectMenuBuilder {
        return new ChannelSelectMenuBuilder()
            .setCustomId(ALERTS_CHANNEL_SELECT_ID)
            .setPlaceholder('Select a text channel for release alerts…')
            .setChannelTypes(ChannelType.GuildText)
            .setMinValues(1)
            .setMaxValues(1);
    }

    /**
     * Set the channel where release alerts are sent in this server.
     */
    @Slash({
        description: 'Set the channel for release alerts in this server',
        defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
    })
    async setalertschannel(interaction: CommandInteraction, _client: Client): Promise<void> {
        if (!interaction.guildId) {
            const container = new ContainerBuilder().addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                    '## ❌ **Server only**\n\n> This command can only be used in a server.'
                )
            );
            await interaction.reply({
                components: [container],
                flags: [MessageFlags.Ephemeral, MessageFlags.IsComponentsV2],
            });
            return;
        }

        const current = await getAlertsChannelForGuild(interaction.guildId);
        const bodyText = current
            ? `Current alerts channel: <#${current}>. Select a channel below to change it`
            : 'Select a text channel below to send release alerts to.';
        const text = new TextDisplayBuilder().setContent(
            ['## 📍 **Set alerts channel**', '', bodyText].join('\n')
        );
        const select = SetAlertsChannel.buildChannelSelectMenu();
        const container = new ContainerBuilder()
            .addTextDisplayComponents(text)
            .addActionRowComponents((row) => row.addComponents(select));

        await interaction.reply({
            components: [container],
            flags: [MessageFlags.Ephemeral, MessageFlags.IsComponentsV2],
        });
    }

    @SelectMenuComponent({ id: ALERTS_CHANNEL_SELECT_ID })
    async onChannelSelect(
        interaction: ChannelSelectMenuInteraction,
        _client: Client
    ): Promise<void> {
        if (!interaction.guildId) {
            const container = new ContainerBuilder().addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                    '## ❌ **Server only**\n\n> This menu can only be used in a server.'
                )
            );
            await interaction.reply({
                components: [container],
                flags: [MessageFlags.Ephemeral, MessageFlags.IsComponentsV2],
            });
            return;
        }

        const channel = interaction.channels.first();
        const isGuildText = channel && 'guild' in channel && channel.type === ChannelType.GuildText;
        if (!isGuildText) {
            const container = new ContainerBuilder().addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                    '## ❌ **Invalid channel**\n\n> Please select a text channel.'
                )
            );
            await interaction.reply({
                components: [container],
                flags: [MessageFlags.Ephemeral, MessageFlags.IsComponentsV2],
            });
            return;
        }

        const resolvedChannel = channel;
        const me =
            resolvedChannel.guild.members.me ?? (await resolvedChannel.guild.members.fetchMe());
        const perms = resolvedChannel.permissionsFor(me);
        const canView = perms?.has(PermissionFlagsBits.ViewChannel) ?? false;
        const canSend = perms?.has(PermissionFlagsBits.SendMessages) ?? false;
        const hasRequiredPerms = canView && canSend;
        if (!hasRequiredPerms) {
            const container = new ContainerBuilder().addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                    [
                        '## ❌ **Missing permissions**',
                        '',
                        `> I don't have permission to send messages in <#${resolvedChannel.id}>. I need **View Channel** and **Send Messages** there.`,
                    ].join('\n')
                )
            );
            await interaction.reply({
                components: [container],
                flags: [MessageFlags.Ephemeral, MessageFlags.IsComponentsV2],
            });
            return;
        }

        await setAlertsChannelForGuild(interaction.guildId, resolvedChannel.id);
        const container = new ContainerBuilder().addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
                [
                    '## ✅ **Alerts channel set**',
                    '',
                    `> Release alerts for this server will be sent to <#${resolvedChannel.id}>.`,
                ].join('\n')
            )
        );
        await interaction.reply({
            components: [container],
            flags: [MessageFlags.Ephemeral, MessageFlags.IsComponentsV2],
        });
    }
}
