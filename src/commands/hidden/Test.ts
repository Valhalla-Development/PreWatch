import { Category } from '@discordx/utilities';
import {
    ApplicationCommandOptionType,
    type CommandInteraction,
    MessageFlags,
    PermissionFlagsBits,
} from 'discord.js';
import { type Client, Discord, Slash, SlashOption } from 'discordx';
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
        await interaction.reply({
            content: `🧪 Testing release: \`${releaseName}\``,
            flags: MessageFlags.Ephemeral,
        });

        await testNotification(interaction.client as Client, releaseName);
    }
}
