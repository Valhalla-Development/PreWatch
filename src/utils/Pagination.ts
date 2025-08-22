import {
    ActionRowBuilder,
    ButtonBuilder,
    type ButtonInteraction,
    ButtonStyle,
    type CommandInteraction,
    type EmbedBuilder,
    type Interaction,
} from 'discord.js';

/**
 * Creates a pagination system for a list of embeds with next, back, and home buttons.
 * @param interaction - The interaction that triggered the pagination.
 * @param embeds - An array of EmbedBuilders to paginate.
 * @param emojiNext - The emoji to use for the next button. Defaults to '▶️'.
 * @param emojiHome - The emoji to use for the home button. Defaults to '🏠'.
 * @param emojiBack - The emoji to use for the back button. Defaults to '◀️'.
 * @returns A promise that resolves with void when the pagination is complete.
 */
export async function pagination(
    interaction: CommandInteraction,
    embeds: EmbedBuilder[],
    emojiNext: string,
    emojiHome: string,
    emojiBack: string
) {
    // Guard: no embeds to paginate
    if (embeds.length === 0) {
        await interaction.reply({ content: 'Nothing to display.', ephemeral: true });
        return;
    }
    const back = new ButtonBuilder()
        .setCustomId('back')
        .setEmoji(emojiBack)
        .setStyle(ButtonStyle.Primary)
        .setDisabled(true);

    const home = new ButtonBuilder()
        .setCustomId('home')
        .setEmoji(emojiHome)
        .setStyle(ButtonStyle.Primary)
        .setDisabled(true);

    const next = new ButtonBuilder()
        .setCustomId('next')
        .setEmoji(emojiNext)
        .setStyle(ButtonStyle.Primary);

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(back, home, next);

    const m = await interaction.reply({
        embeds: [embeds[0]!],
        components: [row],
        fetchReply: true,
    });

    const filter = (i: Interaction) => {
        if (!i.isButton()) {
            return false;
        }
        const button = i as ButtonInteraction;
        return button.user.id === interaction.user.id;
    };

    const collector = m.createMessageComponentCollector({
        filter,
        time: 30_000,
    });

    let currentPage = 0;

    collector.on('collect', async (b) => {
        collector.resetTimer();

        if (b.customId === 'back' && currentPage !== 0) {
            if (currentPage === embeds.length - 1) {
                next.setDisabled(false);
            }

            currentPage -= 1;

            if (currentPage === 0) {
                back.setDisabled(true);
                home.setDisabled(true);
            }

            const rowNew = new ActionRowBuilder<ButtonBuilder>().addComponents(back, home, next);

            await b.update({
                embeds: [embeds[currentPage]!],
                components: [rowNew],
            });
        }

        if (b.customId === 'next' && currentPage < embeds.length - 1) {
            currentPage += 1;

            if (currentPage === embeds.length - 1) {
                next.setDisabled(true);
            }

            home.setDisabled(false);
            back.setDisabled(false);

            const rowNew = new ActionRowBuilder<ButtonBuilder>().addComponents(back, home, next);

            await b.update({
                embeds: [embeds[currentPage]!],
                components: [rowNew],
            });
        }

        if (b.customId === 'home') {
            currentPage = 0;
            home.setDisabled(true);
            back.setDisabled(true);
            next.setDisabled(false);

            const rowNew = new ActionRowBuilder<ButtonBuilder>().addComponents(back, home, next);

            await b.update({ embeds: [embeds[currentPage]!], components: [rowNew] });
        }
    });

    collector.on('end', () => {
        home.setDisabled(true);
        back.setDisabled(true);
        next.setDisabled(true);

        interaction.editReply({ embeds: [embeds[currentPage]!], components: [row] });
    });

    collector.on('error', (e: Error) => console.log(e));
}
