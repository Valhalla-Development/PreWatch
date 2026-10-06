import type KeyvSqlite from '@keyv/sqlite';

/**
 * Keyv's SQLite adapter removes expired keys on reads. Unique delivery receipts
 * need periodic pruning because most are never read again after delivery.
 */
export async function pruneDeliveryReceipts(store: KeyvSqlite): Promise<void> {
    await store.query(
        "DELETE FROM keyv WHERE key LIKE 'data:delivered:%' AND json_valid(value) AND json_extract(value, '$.expires') <= ?",
        Date.now()
    );
}
