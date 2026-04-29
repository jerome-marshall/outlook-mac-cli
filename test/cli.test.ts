/**
 * Unit tests for CLI-specific modules:
 *
 *   - cli/approval-runtime.ts  -- disk-backed token store
 *   - cli/output.ts            -- JSON envelope, NDJSON streaming, table fallback
 *   - cli/argv.ts              -- arg parsers, body resolution, csv splitter
 *   - cli/config.ts            -- ~/.olk/config.json read/write
 *   - approval/token-manager   -- contract holds when wired to a disk store
 *
 * These exercise the CLI bits that were not in the upstream MCP project. The
 * tests run without Outlook running and without touching the user's HOME (each
 * test points OLK_HOME at a unique tmpdir).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decode } from '@toon-format/toon';

import { ApprovalTokenManager } from '../src/approval/token-manager.js';
import { DiskTokenStore, approvalsDir } from '../src/cli/approval-runtime.js';
import {
    parseAttachment,
    parseInlineImage,
    parseNonNegativeInt,
    parsePositiveInt,
    splitCsv,
} from '../src/cli/argv.js';
import { configPath, loadConfig, saveConfig, setConfigValue, unsetConfigValue } from '../src/cli/config.js';
import { buildProgram } from '../src/cli/index.js';
import { emitError, emitSuccess } from '../src/cli/output.js';
import { ValidationError } from '../src/utils/errors.js';

// =============================================================================
// Sandbox helpers
// =============================================================================

let sandbox: string;
let originalHome: string | undefined;

beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'olk-test-'));
    originalHome = process.env['OLK_HOME'];
    process.env['OLK_HOME'] = sandbox;
});

afterEach(() => {
    if (originalHome === undefined) delete process.env['OLK_HOME'];
    else process.env['OLK_HOME'] = originalHome;
    rmSync(sandbox, { recursive: true, force: true });
});

// =============================================================================
// DiskTokenStore
// =============================================================================

describe('DiskTokenStore', () => {
    it('persists tokens across instances at the OLK_HOME-scoped directory', () => {
        const dir = approvalsDir();
        expect(dir.startsWith(sandbox)).toBe(true);

        const a = new DiskTokenStore();
        const token = {
            tokenId: 'abc123',
            operation: 'delete_email' as const,
            targetType: 'email' as const,
            targetId: 42,
            targetHash: 'fedcba9876543210',
            createdAt: 1000,
            expiresAt: Date.now() + 60_000,
            metadata: Object.freeze({}),
        };
        a.set(token.tokenId, token);

        const b = new DiskTokenStore();
        const reread = b.get('abc123');
        expect(reread).toBeDefined();
        expect(reread?.targetId).toBe(42);
        expect(reread?.metadata).toEqual({});
    });

    it('returns undefined and silently cleans corrupted files', () => {
        const store = new DiskTokenStore();
        const dir = approvalsDir();
        const corruptPath = join(dir, 'bad-token.json');
        writeFileSync(corruptPath, '{not-json');
        expect(store.get('bad-token')).toBeUndefined();
        expect(existsSync(corruptPath)).toBe(false);
    });

    it('rejects token ids that try to escape the directory', () => {
        const store = new DiskTokenStore();
        expect(() => store.set('../escape', {} as never)).toThrow();
        expect(() => store.get('../escape')).toThrow();
    });

    it('iterates only token files (skips non-json content)', () => {
        const store = new DiskTokenStore();
        const dir = approvalsDir();
        writeFileSync(join(dir, 'README.txt'), 'not a token');
        const token = {
            tokenId: 'iter-1',
            operation: 'delete_email' as const,
            targetType: 'email' as const,
            targetId: 1,
            targetHash: 'h',
            createdAt: 0,
            expiresAt: Date.now() + 60_000,
            metadata: Object.freeze({}),
        };
        store.set(token.tokenId, token);
        const ids = Array.from(store.entries()).map(([id]) => id);
        expect(ids).toEqual(['iter-1']);
    });

    it('wires into ApprovalTokenManager so prepare/confirm work across instances', () => {
        const m1 = new ApprovalTokenManager(60_000, new DiskTokenStore());
        const token = m1.generateToken({
            operation: 'delete_email',
            targetType: 'email',
            targetId: 7,
            targetHash: 'abc',
        });
        // Second manager (e.g., second CLI invocation) reads from the same store.
        const m2 = new ApprovalTokenManager(60_000, new DiskTokenStore());
        const result = m2.consumeToken(token.tokenId, 'delete_email', 7);
        expect(result.valid).toBe(true);
        // After consumption, neither manager can re-use it.
        const reuse = m2.consumeToken(token.tokenId, 'delete_email', 7);
        expect(reuse.valid).toBe(false);
    });

    it('expired tokens are rejected and cleaned up by GC', () => {
        const m = new ApprovalTokenManager(1, new DiskTokenStore());
        const token = m.generateToken({
            operation: 'delete_email',
            targetType: 'email',
            targetId: 1,
            targetHash: 'a',
        });
        // Token is born already-expired (TTL 1ms).
        const future = Date.now() + 5;
        while (Date.now() < future) { /* spin */ }
        const result = m.validateToken(token.tokenId, 'delete_email', 1);
        expect(result.valid).toBe(false);
        expect(result.error).toBe('EXPIRED');
        m.cleanupExpiredTokens();
        expect(m.size).toBe(0);
    });
});

// =============================================================================
// argv helpers
// =============================================================================

describe('argv helpers', () => {
    it('parsePositiveInt accepts positive ints and rejects others', () => {
        expect(parsePositiveInt('1', 'x')).toBe(1);
        expect(parsePositiveInt('123', 'x')).toBe(123);
        expect(() => parsePositiveInt('0', 'x')).toThrow(ValidationError);
        expect(() => parsePositiveInt('-3', 'x')).toThrow(ValidationError);
        expect(() => parsePositiveInt('abc', 'x')).toThrow(ValidationError);
        expect(() => parsePositiveInt('1.5', 'x')).toThrow(ValidationError);
    });

    it('parseNonNegativeInt accepts 0 and positives, rejects negatives', () => {
        expect(parseNonNegativeInt('0', 'x')).toBe(0);
        expect(parseNonNegativeInt('5', 'x')).toBe(5);
        expect(() => parseNonNegativeInt('-1', 'x')).toThrow(ValidationError);
    });

    it('splitCsv trims and drops empty entries', () => {
        expect(splitCsv('a,b,c')).toEqual(['a', 'b', 'c']);
        expect(splitCsv(' a , , b ')).toEqual(['a', 'b']);
        expect(splitCsv('')).toBeUndefined();
        expect(splitCsv(undefined)).toBeUndefined();
    });

    it('parseInlineImage extracts cid=path pairs', () => {
        expect(parseInlineImage('logo=/tmp/logo.png')).toEqual({ content_id: 'logo', path: '/tmp/logo.png' });
        expect(parseInlineImage('cid=/tmp/foo=bar.png')).toEqual({ content_id: 'cid', path: '/tmp/foo=bar.png' });
        expect(() => parseInlineImage('logo')).toThrow(ValidationError);
        expect(() => parseInlineImage('=path')).toThrow(ValidationError);
    });

    it('parseAttachment supports optional :name suffix', () => {
        expect(parseAttachment('/tmp/file.pdf')).toEqual({ path: '/tmp/file.pdf' });
        expect(parseAttachment('/tmp/file.pdf:Report.pdf')).toEqual({ path: '/tmp/file.pdf', name: 'Report.pdf' });
    });
});

// =============================================================================
// config
// =============================================================================

describe('config', () => {
    it('returns an empty object when no config file exists', () => {
        expect(loadConfig()).toEqual({});
    });

    it('persists set/get round-trip', () => {
        setConfigValue('defaultOutput', 'ndjson');
        const config = loadConfig();
        expect(config.defaultOutput).toBe('ndjson');
        expect(JSON.parse(readFileSync(configPath(), 'utf8'))).toEqual({ defaultOutput: 'ndjson' });
    });

    it('accepts toon as a default output format', () => {
        setConfigValue('defaultOutput', 'toon');
        expect(loadConfig().defaultOutput).toBe('toon');
    });

    it('rejects invalid values', () => {
        expect(() => setConfigValue('defaultOutput', 'csv')).toThrow(ValidationError);
        expect(() => setConfigValue('defaultFolder', '-1')).toThrow(ValidationError);
        expect(() => setConfigValue('unknown', 'x')).toThrow(ValidationError);
    });

    it('unset removes a key but keeps others', () => {
        saveConfig({ defaultOutput: 'json', defaultFolder: 7 });
        const updated = unsetConfigValue('defaultFolder');
        expect(updated).toEqual({ defaultOutput: 'json' });
    });

    it('treats a corrupted config as empty', () => {
        writeFileSync(configPath(), '{not-json');
        expect(loadConfig()).toEqual({});
    });
});

// =============================================================================
// output formatter
// =============================================================================

describe('output formatter', () => {
    it('emits a {ok:true,data:...} success envelope to stdout', () => {
        const writes: string[] = [];
        const original = process.stdout.write.bind(process.stdout);
        process.stdout.write = ((chunk: unknown) => {
            writes.push(String(chunk));
            return true;
        }) as typeof process.stdout.write;
        try {
            emitSuccess({ count: 3 }, { format: 'json', noColor: true });
        }
        finally {
            process.stdout.write = original;
        }
        const lines = writes.join('').trim().split('\n');
        expect(lines).toHaveLength(1);
        expect(JSON.parse(lines[0])).toEqual({ ok: true, data: { count: 3 } });
    });

    it('emits a lossless TOON success envelope to stdout', () => {
        const writes: string[] = [];
        const original = process.stdout.write.bind(process.stdout);
        process.stdout.write = ((chunk: unknown) => {
            writes.push(String(chunk));
            return true;
        }) as typeof process.stdout.write;
        try {
            emitSuccess({
                items: [
                    { id: 1, subject: 'Hello "TOON"', senderAddress: 'alice@example.com', isRead: false },
                    { id: 2, subject: 'Lunch?', senderAddress: 'bob@example.com', isRead: true },
                ],
                count: 2,
                hasMore: false,
            }, { format: 'toon', noColor: true });
        }
        finally {
            process.stdout.write = original;
        }
        expect(decode(writes.join('').trim())).toEqual({
            ok: true,
            data: {
                items: [
                    { id: 1, subject: 'Hello "TOON"', senderAddress: 'alice@example.com', isRead: false },
                    { id: 2, subject: 'Lunch?', senderAddress: 'bob@example.com', isRead: true },
                ],
                count: 2,
                hasMore: false,
            },
        });
    });

    it('preserves nested arrays and null fields in TOON output', () => {
        const writes: string[] = [];
        const original = process.stdout.write.bind(process.stdout);
        process.stdout.write = ((chunk: unknown) => {
            writes.push(String(chunk));
            return true;
        }) as typeof process.stdout.write;
        try {
            emitSuccess({
                id: 42,
                title: 'Design review',
                location: null,
                attendees: [
                    { name: 'Alice', email: 'alice@example.com', status: 'accepted' },
                    { name: null, email: 'room@example.com', status: 'none' },
                ],
            }, { format: 'toon', noColor: true });
        }
        finally {
            process.stdout.write = original;
        }
        expect(decode(writes.join('').trim())).toEqual({
            ok: true,
            data: {
                id: 42,
                title: 'Design review',
                location: null,
                attendees: [
                    { name: 'Alice', email: 'alice@example.com', status: 'accepted' },
                    { name: null, email: 'room@example.com', status: 'none' },
                ],
            },
        });
    });

    it('NDJSON streams one item per line for list payloads', () => {
        const writes: string[] = [];
        const original = process.stdout.write.bind(process.stdout);
        process.stdout.write = ((chunk: unknown) => {
            writes.push(String(chunk));
            return true;
        }) as typeof process.stdout.write;
        try {
            emitSuccess({ items: [{ a: 1 }, { a: 2 }], count: 2, hasMore: false }, { format: 'ndjson', noColor: true });
        }
        finally {
            process.stdout.write = original;
        }
        const lines = writes.join('').trim().split('\n');
        expect(lines).toHaveLength(2);
        expect(JSON.parse(lines[0])).toEqual({ a: 1 });
        expect(JSON.parse(lines[1])).toEqual({ a: 2 });
    });

    it('emits a {ok:false,error:{code,message}} envelope to stderr for errors', () => {
        const writes: string[] = [];
        const original = process.stderr.write.bind(process.stderr);
        process.stderr.write = ((chunk: unknown) => {
            writes.push(String(chunk));
            return true;
        }) as typeof process.stderr.write;
        let exitCode = 0;
        try {
            exitCode = emitError(new ValidationError('bad input'), { format: 'json', noColor: true });
        }
        finally {
            process.stderr.write = original;
        }
        expect(exitCode).toBe(1);
        const env = JSON.parse(writes.join('').trim());
        expect(env.ok).toBe(false);
        expect(env.error.code).toBe('VALIDATION_ERROR');
        expect(env.error.message).toBe('bad input');
    });

    it('keeps error envelopes as JSON even when TOON is requested', () => {
        const writes: string[] = [];
        const original = process.stderr.write.bind(process.stderr);
        process.stderr.write = ((chunk: unknown) => {
            writes.push(String(chunk));
            return true;
        }) as typeof process.stderr.write;
        try {
            expect(emitError(new ValidationError('bad input'), { format: 'toon', noColor: true })).toBe(1);
        }
        finally {
            process.stderr.write = original;
        }
        expect(JSON.parse(writes.join('').trim())).toEqual({
            ok: false,
            error: {
                code: 'VALIDATION_ERROR',
                message: 'bad input',
            },
        });
    });

    it('table mode renders a header and aligned rows for list payloads', () => {
        const writes: string[] = [];
        const original = process.stdout.write.bind(process.stdout);
        process.stdout.write = ((chunk: unknown) => {
            writes.push(String(chunk));
            return true;
        }) as typeof process.stdout.write;
        try {
            emitSuccess({
                items: [
                    { id: 1, name: 'Alpha' },
                    { id: 2, name: 'Beta' },
                ],
                count: 2,
                hasMore: false,
            }, { format: 'table', noColor: true });
        }
        finally {
            process.stdout.write = original;
        }
        const out = writes.join('');
        expect(out).toContain('id');
        expect(out).toContain('name');
        expect(out).toContain('Alpha');
        expect(out).toContain('Beta');
    });
});

// =============================================================================
// CLI program
// =============================================================================

describe('CLI program', () => {
    it('honors --toon as a root output flag', async () => {
        const writes: string[] = [];
        const original = process.stdout.write.bind(process.stdout);
        process.stdout.write = ((chunk: unknown) => {
            writes.push(String(chunk));
            return true;
        }) as typeof process.stdout.write;
        try {
            const program = buildProgram();
            program.exitOverride();
            program.configureOutput({
                writeOut: () => undefined,
                writeErr: () => undefined,
            });
            await program.parseAsync(['node', 'olk', '--toon', 'version']);
        }
        finally {
            process.stdout.write = original;
        }
        expect(decode(writes.join('').trim())).toEqual({
            ok: true,
            data: {
                cli: '0.1.0',
                upstream: '1.1.1',
                upstreamRepo: 'https://github.com/hasan-imam/mcp-outlook-applescript',
            },
        });
    });
});
