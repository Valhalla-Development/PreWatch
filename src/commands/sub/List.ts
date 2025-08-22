import { Category } from '@discordx/utilities';
import type { CommandInteraction } from 'discord.js';
import { type Client, Discord, Slash } from 'discordx';

@Discord()
@Category('Sub')
export class List {
    /**
     * ...
     */
    @Slash({ description: '...' })
    async list(_interaction: CommandInteraction, client: Client): Promise<void> {
        // TODO: Implement
        // will be a pagination of components, query on each, with buttons to either:
        // get; will run a manual check for the query, with ratelimit
        // remove; will remove the query from the list
    }
}
