import {
    ActivityType,
    ChannelType,
    codeBlock,
    EmbedBuilder,
    type Message,
    type TextChannel,
} from 'discord.js';
import type { Client } from 'discordx';
import '@colors/colors';
import KeyvSqlite from '@keyv/sqlite';
import axios from 'axios';
import Keyv from 'keyv';
import WebSocket from 'ws';
import { config } from '../config/Config.js';

// API Response Types
type Nuke = {
    id: number;
    typeId: number;
    type: string;
    preId: number;
    reason: string;
    net: string;
    nukeAt: number;
};

type Release = {
    id: number;
    name: string;
    team: string;
    cat: string;
    genre: string;
    url: string;
    size: number;
    files: number;
    preAt: number;
    nuke: Nuke | null;
};

type WebSocketMessage = {
    action: 'insert' | 'update' | 'delete' | 'nuke' | 'unnuke' | 'modnuke' | 'delpre' | 'undelpre';
    row: Release;
};

export const keyv = new Keyv({
    store: new KeyvSqlite({ uri: 'sqlite://src/data/db.sqlite' }),
    namespace: 'data',
});
keyv.on('error', (err) => console.log('[keyv] Connection Error', err));

/**
 * Capitalises the first letter of each word in a string.
 * @param str - The string to be capitalised.
 * @returns The capitalised string.
 */
export const capitalise = (str: string): string => str.replace(/\b\w/g, (c) => c.toUpperCase());

/**
 * Deletes a message after a specified delay if it's deletable.
 * @param message - The message to delete.
 * @param time - The delay before deletion, in milliseconds.
 */
export function deletableCheck(message: Message, time: number): void {
    setTimeout(() => {
        message.delete().catch((error) => console.error('Error deleting message:', error));
    }, time);
}

/**
 * Fetches command IDs for both global and guild commands.
 * @param client - The Discord client instance
 * @returns Promise resolving to a record of command names to their IDs
 */
export async function getCommandIds(
    client: Client,
    guildId: string
): Promise<Record<string, string>> {
    if (!client.application) {
        throw new Error('Client application is not available');
    }

    const commandIds = new Map<string, string>();
    const isGuildOnly = client.botGuilds && client.botGuilds.length > 0;

    // Fetch global commands
    if (!isGuildOnly) {
        try {
            const globalCommands = await client.application.commands.fetch();
            for (const cmd of globalCommands.values()) {
                commandIds.set(cmd.name, cmd.id);
            }
        } catch (error) {
            console.warn('Could not fetch global commands:', error);
        }
    }

    // Fetch guild commands
    const guild = client.guilds.cache.get(guildId);
    if (guild) {
        try {
            const guildCommands = await guild.commands.fetch();
            for (const cmd of guildCommands.values()) {
                commandIds.set(cmd.name, cmd.id);
            }
        } catch (error) {
            console.warn(`Could not fetch commands for guild ${guild.name}:`, error);
        }
    }

    return Object.fromEntries(commandIds);
}

/**
 * Updates the status of the Discord client with information about guilds and users.
 * @param client - The Discord client instance.
 */
export function updateStatus(client: Client) {
    client.user?.setActivity({
        type: ActivityType.Watching,
        name: `${client.guilds.cache.size.toLocaleString('en')} Guilds
            ${client.guilds.cache.reduce((a, b) => a + b.memberCount, 0).toLocaleString('en')} Users`,
    });
}

/**
 * Applies a reversed rainbow effect to the input string.
 * @param str - The string to apply the reversed rainbow effect.
 * @returns The input string with reversed rainbow coloring.
 */
export const reversedRainbow = (str: string): string => {
    const colors = ['red', 'magenta', 'blue', 'green', 'yellow', 'red'] as const;
    return str
        .split('')
        .map((char, i) => char[colors[i % colors.length] as keyof typeof char])
        .join('');
};

/**
 * Handles given error by logging it and optionally sending it to a Discord channel.
 * @param client - The Discord client instance
 * @param error - The unknown error
 */
export async function handleError(client: Client, error: unknown): Promise<void> {
    // Properly log the raw error for debugging
    console.error('Raw error:', error);

    // Create an error object if we received something else
    const normalizedError = error instanceof Error ? error : new Error(String(error));

    // Ensure we have a stack trace
    const errorStack = normalizedError.stack || normalizedError.message || String(error);

    if (!(config.ENABLE_LOGGING && config.ERROR_LOGGING_CHANNEL)) {
        return;
    }

    /**
     * Truncates the description if it exceeds the maximum length.
     * @param description - The description to truncate
     * @returns The truncated description
     */
    function truncateDescription(description: string): string {
        const maxLength = 4096;
        if (description.length <= maxLength) {
            return description;
        }
        const numTruncatedChars = description.length - maxLength;
        return `${description.slice(0, maxLength)}... ${numTruncatedChars} more`;
    }

    try {
        const channel = client.channels.cache.get(config.ERROR_LOGGING_CHANNEL!) as
            | TextChannel
            | undefined;

        if (!channel || channel.type !== ChannelType.GuildText) {
            console.error(`Invalid logging channel: ${config.ERROR_LOGGING_CHANNEL}`);
            return;
        }

        const typeOfError = normalizedError.name || 'Unknown Error';
        const timeOfError = `<t:${Math.floor(Date.now() / 1000)}>`;

        const fullString = [
            `From: \`${typeOfError}\``,
            `Time: ${timeOfError}`,
            '',
            'Error:',
            codeBlock('js', errorStack),
        ].join('\n');

        const embed = new EmbedBuilder()
            .setTitle('Error')
            .setDescription(truncateDescription(fullString))
            .setColor('#FF0000');

        await channel.send({ embeds: [embed] });
    } catch (sendError) {
        console.error('Failed to send the error embed:', sendError);
    }
}

/**
 * Checks the health of the API by hitting the /stats endpoint.
 * @returns Promise resolving to true if API is healthy, false otherwise
 */
export async function checkApiHealth(): Promise<boolean> {
    try {
        const response = await axios.get(`${config.API_URL}/stats`);

        // Check if response has expected structure and data
        const isHealthy =
            response.data.status === 'success' &&
            response.data.data &&
            typeof response.data.data.total === 'number' &&
            response.data.data.total > 0;

        if (isHealthy) {
            const totalReleases = response.data.data.total.toLocaleString('en');
            console.log(
                `${'>>'.green} [API STATUS] `.white +
                    `API is healthy! Total releases: ${totalReleases}`.green
            );
        } else {
            console.warn(
                `${'>>'.yellow} [API STATUS] `.white +
                    'API health check failed: Invalid response structure or no data'.yellow
            );
        }

        return isHealthy;
    } catch (error) {
        console.error(`${'>>'.red} [API STATUS] `.white + `API health check failed: ${error}`.red);
        return false;
    }
}

/**
 * Connects to the WebSocket for real-time release updates.
 * @param onMessage - Callback function to handle incoming release data
 * @returns WebSocket connection instance
 */
export function connectToReleaseStream(onMessage: (data: WebSocketMessage) => void): WebSocket {
    const wsUrl = `${config.API_URL}/ws`;
    const ws = new WebSocket(wsUrl);

    ws.on('open', () => {
        console.log(
            `${'>>'.green} [WEBSOCKET] `.white + 'Connected to real-time release stream'.green
        );
    });

    ws.on('message', (data: WebSocket.Data) => {
        try {
            const release = JSON.parse(data.toString());

            // Only process 'insert' actions
            if (release.action === 'insert') {
                console.log(
                    `${'>>'.blue} [WEBSOCKET] `.white +
                        `Received ${release.action}: ${release.row?.name || 'Unknown'}`.blue
                );
                onMessage(release);
            }
        } catch (error) {
            console.error(
                `${'>>'.red} [WEBSOCKET] `.white + `Failed to parse message: ${error}`.red
            );
        }
    });

    ws.on('error', (error) => {
        console.error(`${'>>'.red} [WEBSOCKET] `.white + `Connection error: ${error}`.red);
    });

    ws.on('close', (code, reason) => {
        console.warn(
            `${'>>'.yellow} [WEBSOCKET] `.white + `Connection closed: ${code} - ${reason}`.yellow
        );

        // Auto-reconnect after 5 seconds
        setTimeout(() => {
            console.log(`${'>>'.cyan} [WEBSOCKET] `.white + 'Attempting to reconnect...'.cyan);
            connectToReleaseStream(onMessage);
        }, 5000);
    });

    return ws;
}
