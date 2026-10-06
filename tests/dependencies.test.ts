import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, get } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import KeyvSqlite from '@keyv/sqlite';
import { spawn } from 'bun';
import HttpProxyAgent from 'http-proxy-agent';
import Keyv from 'keyv';
import { create, extract } from 'tar';

const require = createRequire(import.meta.url);
interface BraceNode {
    nodes?: BraceNode[];
    type: string;
    value?: string;
}
const braces = require('braces') as {
    compile: (input: string | BraceNode) => string;
    expand: (input: string | BraceNode) => string[];
    parse: (input: string) => BraceNode;
    stringify: (input: string | BraceNode) => string;
};

describe('dependency security compatibility', () => {
    test('normal brace patterns still compile and expand', () => {
        expect(braces.compile('a/{b,c}/d')).toBe('a/(b|c)/d');
        expect(braces.expand('a/{b,c}/d')).toEqual(['a/b/d', 'a/c/d']);
        expect(braces.stringify(braces.parse('a/{b,c}/d'))).toBe('a/{b,c}/d');
    });

    test('rejects deeply nested input before recursive processing', () => {
        const nested = `${'{'.repeat(256)}a,b${'}'.repeat(256)}`;
        expect(() => braces.parse(nested)).toThrow('maximum depth');
        expect(() => braces.compile(nested)).toThrow('maximum depth');
        expect(() => braces.expand(nested)).toThrow('maximum depth');
        expect(() => braces.stringify(nested)).toThrow('maximum depth');
    });

    test('guards caller-provided ASTs as well as parsed input', () => {
        let ast: BraceNode = { type: 'text', value: 'a' };
        for (let depth = 0; depth < 256; depth += 1) {
            ast = { nodes: [ast], type: 'root' };
        }
        expect(() => braces.compile(ast)).toThrow('maximum depth');
        expect(() => braces.expand(ast)).toThrow('maximum depth');
        expect(() => braces.stringify(ast)).toThrow('maximum depth');
    });

    test('SQLite storage persists and reopens records with the updated install dependencies', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'prewatch-sqlite-'));
        const uri = `sqlite://${join(directory, 'test.sqlite')}`;
        let storage = new KeyvSqlite({ busyTimeout: 5000, uri });
        try {
            let keyv = new Keyv({ namespace: 'data', store: storage, throwOnErrors: true });
            await keyv.set('subscription', { users: ['one', 'two'] });
            await storage.disconnect();
            storage = new KeyvSqlite({ busyTimeout: 5000, uri });
            keyv = new Keyv({ namespace: 'data', store: storage, throwOnErrors: true });
            expect(await keyv.get('subscription')).toEqual({ users: ['one', 'two'] });
        } finally {
            await storage.disconnect();
            await rm(directory, { recursive: true });
        }
    });

    test('patched tar supports the SQLite extraction script and node-gyp streaming API', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'prewatch-tar-'));
        try {
            const input = join(directory, 'headers');
            const output = join(directory, 'output');
            const archive = join(directory, 'headers.tar.gz');
            await mkdir(input);
            await mkdir(output);
            await writeFile(join(input, 'test.h'), 'test header');
            await create({ cwd: directory, file: archive, gzip: true }, ['headers/test.h']);
            const extraction = spawn(
                ['node', require.resolve('sqlite3/deps/extract.js'), archive, output],
                { stderr: 'pipe', stdout: 'pipe' }
            );
            const errors = await new Response(extraction.stderr).text();
            expect(await extraction.exited, errors).toBe(0);
            expect(await readFile(join(output, 'headers/test.h'), 'utf8')).toBe('test header');
            const { createReadStream } = await import('node:fs');
            const { pipeline } = await import('node:stream/promises');
            await pipeline(
                createReadStream(archive),
                extract({ cwd: output, filter: (path) => path.endsWith('.h'), strip: 1 })
            );
            expect(await readFile(join(output, 'test.h'), 'utf8')).toBe('test header');
        } finally {
            await rm(directory, { recursive: true });
        }
    });

    test('the proxy agent works with the updated once event helper', async () => {
        const server = createServer((request, response) => {
            expect(request.url).toBe('http://example.invalid/test');
            response.end('proxied');
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        if (!address || typeof address === 'string') {
            throw new Error('Expected a TCP listener');
        }
        const agent = new HttpProxyAgent(`http://127.0.0.1:${address.port}`);
        try {
            const body = await new Promise<string>((resolve, reject) => {
                const request = get('http://example.invalid/test', { agent }, (response) => {
                    let result = '';
                    response.setEncoding('utf8');
                    response.on('data', (chunk: string) => {
                        result += chunk;
                    });
                    response.on('end', () => resolve(result));
                    response.on('error', reject);
                });
                request.on('error', reject);
                request.setTimeout(2000, () =>
                    request.destroy(new Error('Proxy request timed out'))
                );
            });
            expect(body).toBe('proxied');
        } finally {
            agent.destroy();
            await new Promise<void>((resolve, reject) =>
                server.close((error) => (error ? reject(error) : resolve()))
            );
        }
    });
});
