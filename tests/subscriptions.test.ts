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
mock.module('../src/utils/Console.js', () => ({
    log: { error: mock(), info: mock(), ok: mock(), warn: mock() },
}));
mock.module('../src/config/Config.js', () => ({
    config: {
        API_URL: 'https://example.invalid',
        MAX_SUBSCRIPTIONS_PER_USER: 5,
        POLLING_ENABLED: true,
        POLLING_INTERVAL_SECONDS: 60,
    },
}));
mock.module('../src/utils/Util.js', () => ({
    delay: () => Promise.resolve(),
    handleError: () => Promise.resolve(),
}));
const get = mock();
mock.module('axios', () => ({ default: { get } }));
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

const monitor = await import('../src/utils/Monitor.js');
const notify = await import('../src/utils/Notify.js');
function release(id: number, preAt: number) {
    return {
        cat: 'TV',
        files: 1,
        genre: '',
        id,
        name: 'Alpha.Release-GROUP',
        nuke: null,
        preAt,
        size: 1,
        team: 'GROUP',
        url: '',
    };
}
const send = mock(async () => ({}));
const notificationClient = {
    ...client,
    channels: {
        cache: new Map([
            ['channel', { guild: { id: 'guild' }, id: 'channel', isTextBased: () => true, send }],
        ]),
    },
} as unknown as Parameters<typeof notify.processReleaseNotification>[0];

beforeEach(() => {
    get.mockReset();
    send.mockReset();
    send.mockResolvedValue({});
});

describe('delivery receipts and recovery cursors', () => {
    test('delivers two releases with the same timestamp and a delayed release once each', async () => {
        await create('one');
        const now = Math.floor(Date.now() / 1000);
        const first = release(1, now + 2);
        const second = release(2, now + 2);
        const delayed = release(3, now + 1);
        for (const row of [first, second, delayed, first, second]) {
            // biome-ignore lint/performance/noAwaitInLoops: verify receipt behavior in delivery order
            await notify.processReleaseNotification(notificationClient, { action: 'insert', row });
        }
        expect(send).toHaveBeenCalledTimes(3);
        const seen = await subscriptions.getLastSeenForGuildQuery('guild', 'Alpha');
        expect(seen.preAt).toBe(now + 2);
        expect(seen.pollPreAt).toBe(now);
    });

    test('retrieves more than 100 missed releases without excluding equal timestamps', async () => {
        const rows = Array.from({ length: 121 }, (_, index) => release(121 - index, 200 - index));
        get.mockImplementation((url: string) => {
            const offset = Number(new URL(url).searchParams.get('offset'));
            return { data: { data: { rows: rows.slice(offset, offset + 20) } } };
        });
        const recovered = await monitor.fetchReleasesNewerThan('Alpha', { preAt: 80 }, 0);
        expect(recovered).toHaveLength(121);
        expect(recovered[0]?.preAt).toBe(80);
        expect(get).toHaveBeenCalledTimes(7);
    });

    test('a failed page does not deliver a partial batch or advance its cursor', async () => {
        await create('one');
        const initial = await subscriptions.getLastSeenForGuildQuery('guild', 'Alpha');
        const now = Math.floor(Date.now() / 1000);
        get.mockResolvedValueOnce({
            data: {
                data: { rows: Array.from({ length: 20 }, (_, index) => release(index, now + 1)) },
            },
        });
        get.mockRejectedValueOnce(new Error('Page unavailable'));
        await monitor.pollQueryCatchUp(notificationClient, 'Alpha', 0);
        expect(send).not.toHaveBeenCalled();
        expect(await subscriptions.getLastSeenForGuildQuery('guild', 'Alpha')).toEqual(initial);
    });

    test('failed delivery leaves the polling cursor unchanged and can retry', async () => {
        await create('one');
        const now = Math.floor(Date.now() / 1000);
        const row = release(42, now + 1);
        get.mockResolvedValue({ data: { data: { rows: [row] } } });
        send.mockRejectedValue(new Error('Send unavailable'));
        await monitor.pollQueryCatchUp(notificationClient, 'Alpha', 0);
        expect(await subscriptions.isReleaseDelivered('guild', 'Alpha', row)).toBe(false);
        send.mockResolvedValue({});
        await monitor.pollQueryCatchUp(notificationClient, 'Alpha', 0);
        expect(await subscriptions.isReleaseDelivered('guild', 'Alpha', row)).toBe(true);
    });
});
