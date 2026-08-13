import type { ParsedWatchQuery, Release } from './Types.js';

const QUERY_STOPWORDS = new Set(['a', 'an', 'and', 'of', 'or', 'the', 'to']);

/**
 * Splits a scene fragment on dots, dashes, underscores, and spaces.
 * WEB-DL → [web, dl]. S01E01 and 1080p stay whole tokens.
 */
export function tokenizeSceneFragment(fragment: string): string[] {
    return fragment
        .toLowerCase()
        .split(/[.\s_\-/]+/)
        .map((token) => token.replace(/[^a-z0-9]/g, ''))
        .filter((token) => token.length > 0);
}

function stripSceneGroup(name: string, team: string): string {
    const lower = name.toLowerCase();
    if (team && lower.endsWith(`-${team}`)) {
        return name.slice(0, -(team.length + 1));
    }
    const groupMatch = lower.match(/-([a-z0-9]+)$/);
    if (groupMatch) {
        return name.slice(0, -groupMatch[0].length);
    }
    return name;
}

function tokenizeRelease(release: Release): { cat: string; team: string; tokens: string[] } {
    const team = (release.team || '').toLowerCase();
    const nameTokens = tokenizeSceneFragment(stripSceneGroup(release.name, team));
    if (team) {
        nameTokens.push(team);
    }
    return {
        cat: (release.cat || '').toLowerCase(),
        team,
        tokens: nameTokens,
    };
}

function hasConsecutiveTokens(haystack: string[], needle: string[]): boolean {
    if (needle.length === 0) {
        return true;
    }
    const lastStart = haystack.length - needle.length;
    if (lastStart < 0) {
        return false;
    }
    return haystack
        .slice(0, lastStart + 1)
        .some((_, start) => needle.every((token, offset) => haystack[start + offset] === token));
}

/**
 * Parses a user watch query into tokens plus optional team/cat/quoted filters.
 * Examples: `breaking bad 1080p`, `team:SPARKS`, `cat:X264 "breaking bad"`
 */
export function parseWatchQuery(raw: string): ParsedWatchQuery {
    const exact: string[][] = [];
    const withoutQuotes = raw.replace(/"([^"]+)"/g, (_match, phrase: string) => {
        const phraseTokens = tokenizeSceneFragment(phrase);
        if (phraseTokens.length > 0) {
            exact.push(phraseTokens);
        }
        return ' ';
    });

    const tokens: string[] = [];
    let team: string | undefined;
    let cat: string | undefined;

    for (const part of withoutQuotes.split(/\s+/).filter(Boolean)) {
        const filter = part.match(/^(team|group|cat|category):(.+)$/i);
        if (filter) {
            const key = filter[1]!.toLowerCase();
            const value = filter[2]!.toLowerCase();
            if (!value) {
                continue;
            }
            if (key === 'team' || key === 'group') {
                team = value.replace(/^-+/, '');
            } else {
                cat = value;
            }
            continue;
        }
        if (/^-[a-z0-9]{2,}$/i.test(part)) {
            team = part.slice(1).toLowerCase();
            continue;
        }
        for (const token of tokenizeSceneFragment(part)) {
            if (!QUERY_STOPWORDS.has(token)) {
                tokens.push(token);
            }
        }
    }

    return { cat, exact, team, tokens };
}

export function isWatchQueryUsable(parsed: ParsedWatchQuery): boolean {
    return (
        parsed.tokens.length > 0 ||
        parsed.exact.length > 0 ||
        Boolean(parsed.team) ||
        Boolean(parsed.cat)
    );
}

export function releaseMatchesParsed(parsed: ParsedWatchQuery, release: Release): boolean {
    if (!isWatchQueryUsable(parsed)) {
        return false;
    }

    const scene = tokenizeRelease(release);
    const tokenSet = new Set(scene.tokens);

    if (parsed.team && scene.team !== parsed.team) {
        return false;
    }
    if (parsed.cat && !scene.cat.includes(parsed.cat)) {
        return false;
    }
    if (!parsed.tokens.every((token) => tokenSet.has(token))) {
        return false;
    }
    return parsed.exact.every((phrase) => hasConsecutiveTokens(scene.tokens, phrase));
}

export function releaseMatchesQuery(query: string, release: Release): boolean {
    return releaseMatchesParsed(parseWatchQuery(query), release);
}

/**
 * PreDB search string for poll catch-up. Filters like team: are stripped so
 * the API is only used to fetch candidates; local matching is the authority.
 */
export function pollSearchString(query: string): string {
    const parsed = parseWatchQuery(query);
    const [quoted] = parsed.exact;
    if (quoted && quoted.length > 0) {
        return quoted.join(' ');
    }
    if (parsed.tokens.length > 0) {
        return parsed.tokens.join(' ');
    }
    return parsed.team || parsed.cat || query;
}

export function areWatchQueriesSimilar(left: string, right: string): boolean {
    const parsedLeft = parseWatchQuery(left);
    const parsedRight = parseWatchQuery(right);
    if (parsedLeft.team && parsedRight.team && parsedLeft.team !== parsedRight.team) {
        return false;
    }
    if (parsedLeft.cat && parsedRight.cat && parsedLeft.cat !== parsedRight.cat) {
        return false;
    }

    const tokensLeft = new Set([...parsedLeft.tokens, ...parsedLeft.exact.flat()]);
    const tokensRight = new Set([...parsedRight.tokens, ...parsedRight.exact.flat()]);
    if (tokensLeft.size === 0 || tokensRight.size === 0) {
        return Boolean(
            (parsedLeft.team && parsedLeft.team === parsedRight.team) ||
                (parsedLeft.cat && parsedLeft.cat === parsedRight.cat)
        );
    }

    const smaller = Math.min(tokensLeft.size, tokensRight.size);
    let common = 0;
    for (const token of tokensLeft) {
        if (tokensRight.has(token)) {
            common += 1;
        }
    }
    return common / smaller >= 0.6;
}
