import KeyvSqlite from '@keyv/sqlite';
import Keyv from 'keyv';

export const keyv = new Keyv({
    namespace: 'data',
    store: new KeyvSqlite({ uri: 'sqlite://src/data/db.sqlite' }),
});
keyv.on('error', (err) => console.log('[keyv] Connection Error', err));
