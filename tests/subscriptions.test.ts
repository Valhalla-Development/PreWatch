import { beforeEach, describe, expect, mock, test } from 'bun:test';

const records = new Map<string, unknown>();
let failKey: string | undefined;
const store = {
    delete: async (key: string) => records.delete(key),
    get: async (key: string) => structuredClone(records.get(key)),
    set: async (key: string, value: unknown) => {
        await Promise.resolve();
        if (key === failKey) {
            failKey = undefined;
            throw new Error('Simulated storage failure');
        }
        records.set(key, structuredClone(value));
        return true;
    },
};
mock.module('../src/utils/Store.js', () => ({ keyv: store }));
const subscriptions = await import('../src/utils/Subscriptions.js');
const client = { guilds: { cache: new Map([['guild', {}]]) } };
const typedClient = client as unknown as Parameters<
    typeof subscriptions.rebuildSubscriptionIndex
>[0];

beforeEach(async () => {
    records.clear();
    failKey = undefined;
    records.set('alertsChannel:guild', 'channel');
    await subscriptions.rebuildSubscriptionIndex(typedClient);
});

function create(userId: string, query = 'Alpha', id = userId, limit = 5) {
    return subscriptions.createStoredSubscription({
        guildId: 'guild',
        limit,
        query,
        subscriptionId: id,
        userId,
    });
}

describe('subscription mutations', () => {
    test('keeps both concurrent subscribers after rebuilding the index', async () => {
        await Promise.all([create('one'), create('two')]);
        expect(records.get('query:guild:alpha')).toEqual(['one', 'two']);
        await subscriptions.rebuildSubscriptionIndex(typedClient);
        const active = await subscriptions.getAllActiveSubscriptions(typedClient);
        expect(active[0]?.users.sort()).toEqual(['one', 'two']);
    });

    test('enforces the user limit across simultaneous commands', async () => {
        const results = await Promise.all([
            create('one', 'Alpha', 'a', 1),
            create('one', 'Beta', 'b', 1),
        ]);
        expect(results.filter((result) => result.success)).toHaveLength(1);
        expect(records.get('user:guild:one')).toHaveLength(1);
    });

    test('prevents repeated confirmations from creating duplicate subscriptions', async () => {
        const results = await Promise.all([create('one'), create('one', 'alpha', 'other')]);
        expect(results.filter((result) => result.success)).toHaveLength(1);
    });

    test('restores every record after a failed multi-key mutation', async () => {
        await create('one');
        const original = structuredClone(records);
        failKey = 'query:guild:alpha';
        await expect(create('two')).rejects.toThrow('Simulated storage failure');
        expect(records).toEqual(original);
        const active = await subscriptions.getAllActiveSubscriptions(typedClient);
        expect(active[0]?.users).toEqual(['one']);
    });

    test('unsubscribes case variants using the shared notification query', async () => {
        await create('one', 'Alpha');
        await create('two', 'alpha');
        await subscriptions.rebuildSubscriptionIndex(typedClient);
        const [active] = await subscriptions.getAllActiveSubscriptions(typedClient);
        expect(
            (await subscriptions.unsubscribeFromQuery('one', 'guild', active!.query)).success
        ).toBe(true);
        expect(records.get('query:guild:alpha')).toEqual(['two']);
        expect((await subscriptions.unsubscribeFromQuery('two', 'guild', 'ALPHA')).success).toBe(
            true
        );
        expect(records.has('meta:all_queries:guild')).toBe(false);
    });

    test('restores subscription records when deletion fails', async () => {
        await create('one');
        await create('two');
        const original = structuredClone(records);
        failKey = 'query:guild:alpha';
        expect((await subscriptions.deleteSubscription('guild', 'one', 'one')).success).toBe(false);
        expect(records).toEqual(original);
    });
});
