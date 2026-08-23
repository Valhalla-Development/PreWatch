import KeyvSqlite from '@keyv/sqlite';
import Keyv from 'keyv';
import { log } from './Console.js';

export const keyv = new Keyv({
    namespace: 'data',
    store: new KeyvSqlite({ uri: 'sqlite://src/data/db.sqlite' }),
});
keyv.on('error', (err) => log.error('[keyv] Connection Error', err));
