import { ChannelType, codeBlock, EmbedBuilder, MessageFlags } from 'discord.js';
import { type ArgsOf, type Client, Discord, On } from 'discordx';
import moment from 'moment';
import { config } from '../config/Config.js';
import { handleError, reversedRainbow, unsubscribeFromQuery } from '../utils/Util.js';

@Discord()
export class InteractionCreate {
    /**
     * Handler for interactionCreate event.
     * @param args - An array containing the interaction and client objects.
     * @param client - The Discord client.
     */
    @On({ event: 'interactionCreate' })
    async onInteraction([interaction]: ArgsOf<'interactionCreate'>, client: Client) {
        // Check if the interaction is valid - allow both guild and DM interactions
        if (!interaction.channelId) {
            return;
        }

        const isValidInteraction =
            interaction.isStringSelectMenu() ||
            interaction.isChannelSelectMenu() ||
            interaction.isChatInputCommand() ||
            interaction.isContextMenuCommand() ||
            interaction.isButton();

        if (!isValidInteraction) {
            return;
        }

        // Block DM commands if bot is guild-only
        if (config.GUILDS && !interaction.guildId) {
            if (interaction.isChatInputCommand()) {
                await interaction.reply({
                    content:
                        '🚫 **This bot is configured for guild-only usage.** Please use commands in a server where the bot is installed.',
                    flags: MessageFlags.Ephemeral,
                });
            }
            return;
        }

        try {
            // Handle unsubscribe button clicks
            if (interaction.isButton() && interaction.customId.startsWith('unsub:')) {
                const query = interaction.customId.replace('unsub:', '');
                const userId = interaction.user.id;

                await interaction.deferReply({ flags: MessageFlags.Ephemeral });

                const result = await unsubscribeFromQuery(userId, query);

                await interaction.editReply({
                    content:
                        result.message ||
                        (result.success
                            ? '✅ Successfully unsubscribed!'
                            : '❌ Failed to unsubscribe'),
                });
                return;
            }

            await client.executeInteraction(interaction);
        } catch (err) {
            await handleError(client, err);
            console.error(`Error executing interaction: ${err}`);
        }

        if (config.ENABLE_LOGGING) {
            if (!interaction.isChatInputCommand()) {
                return;
            }

            const reply = await interaction.fetchReply().catch(() => null);

            const link =
                reply?.guildId && reply?.channelId && reply?.id
                    ? `https://discord.com/channels/${reply.guildId}/${reply.channelId}/${reply.id}`
                    : `<#${interaction.channelId}>`;

            const now = Date.now();
            const nowInSeconds = Math.floor(now / 1000);
            const executedCommand = interaction.toString();

            // Console logging
            const guildInfo = interaction.guild
                ? `${'Guild: '.brightBlue.bold}${interaction.guild.name.underline.brightMagenta.bold}`
                : `${'DM'.brightBlue.bold}`;

            console.log(
                `${'◆◆◆◆◆◆'.rainbow.bold} ${moment(now).format('MMM D, h:mm A')} ${reversedRainbow('◆◆◆◆◆◆')}\n` +
                    `${'🔧 Command:'.brightBlue.bold} ${executedCommand.brightYellow.bold}\n` +
                    `${'🔍 Executor:'.brightBlue.bold} ${interaction.user.displayName.underline.brightMagenta.bold} ${'('.gray.bold}${guildInfo}${')'}`
            );

            // Embed logging
            const logEmbed = new EmbedBuilder()
                .setColor('#e91e63')
                .setTitle('Command Executed')
                .addFields(
                    { name: '👤 User', value: `${interaction.user}`, inline: true },
                    { name: '📅 Date', value: `<t:${nowInSeconds}:F>`, inline: true },
                    { name: '📰 Interaction', value: link, inline: true },
                    { name: '🖥️ Command', value: codeBlock('kotlin', executedCommand) }
                );

            // Channel logging
            if (config.COMMAND_LOGGING_CHANNEL) {
                const channel = client.channels.cache.get(config.COMMAND_LOGGING_CHANNEL);
                if (channel?.type === ChannelType.GuildText) {
                    channel.send({ embeds: [logEmbed] }).catch(console.error);
                }
            }
        }
    }
}
