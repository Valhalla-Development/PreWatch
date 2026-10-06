export interface Nuke {
    id: number;
    net: string;
    nukeAt: number;
    preId: number;
    reason: string;
    type: string;
    typeId: number;
}

export interface Release {
    cat: string;
    files: number;
    genre: string;
    id: number;
    name: string;
    nuke: Nuke | null;
    preAt: number;
    size: number;
    team: string;
    url: string;
}

export interface WebSocketMessage {
    action: 'insert' | 'update' | 'delete' | 'nuke' | 'unnuke' | 'modnuke' | 'delpre' | 'undelpre';
    row: Release;
}

export interface LastSeen {
    id?: number;
    pollPreAt?: number;
    preAt?: number;
    startedAt?: number;
}

export interface ParsedWatchQuery {
    cat?: string;
    exact: string[][];
    team?: string;
    tokens: string[];
}

export interface ActiveSubscription {
    channelId: string;
    guildId: string;
    parsed: ParsedWatchQuery;
    query: string;
    users: string[];
}
