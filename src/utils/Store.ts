import KeyvSqlite from '@keyv/sqlite';
import Keyv from 'keyv';
import { log } from './Console.js';

export const keyv = new Keyv({
    namespace: 'data',
    store: new KeyvSqlite({ busyTimeout: 5000, uri: 'sqlite://src/data/db.sqlite' }),
    throwOnErrors: true,
});
keyv.on('error', (err) => log.error('[keyv] Connection Error', err));
