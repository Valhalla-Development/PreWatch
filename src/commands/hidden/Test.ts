import { Category } from '@discordx/utilities';
import {
    ApplicationCommandOptionType,
    type CommandInteraction,
    MessageFlags,
    PermissionFlagsBits,
} from 'discord.js';
import { type Client, Discord, Slash, SlashOption } from 'discordx';
import { isDev } from '../../config/Config.js';
import { testNotification } from '../../utils/Notify.js';

@Discord()
@Category('Hidden')
export class Test {
    @Slash({
        defaultMemberPermissions: PermissionFlagsBits.Administrator,
        description: 'Test the notification system with a mock release (development only)',
    })
    async test(
        @SlashOption({
            description: 'Release name to simulate',
            name: 'release',
            required: true,
            type: ApplicationCommandOptionType.String,
        })
        releaseName: string,
        interaction: CommandInteraction
    ) {
        if (!isDev) {
            await interaction.reply({
                content: '❌ `/test` is only available in development.',
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        await interaction.reply({
            content: `🧪 Testing release: \`${releaseName}\``,
            flags: MessageFlags.Ephemeral,
        });

        await testNotification(interaction.client as Client, releaseName);
    }
}
