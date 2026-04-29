/**
 * Disk-backed approval token store for the CLI.
 *
 * Tokens are persisted as one JSON file per token under `~/.olk/approvals/`,
 * so a `prepare` invocation in one process can be confirmed by a later
 * invocation. The shape on disk matches the in-memory `ApprovalToken` exactly,
 * including `metadata`, so no translation is required at read time.
 *
 * This module deliberately keeps semantics aligned with the upstream
 * `InMemoryTokenStore`: writes overwrite, deletes are silent on missing,
 * iteration yields tokens in arbitrary order. The wrapping `ApprovalTokenManager`
 * still owns expiry, single-use, and operation/target validation.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { ApprovalToken } from '../approval/types.js';
import type { ITokenStore } from '../approval/token-manager.js';

/** Returns the directory used to persist approval tokens. */
export function approvalsDir(): string {
    const override = process.env['OLK_HOME'];
    if (override != null && override.length > 0) {
        return join(override, 'approvals');
    }
    return join(homedir(), '.olk', 'approvals');
}

/**
 * Sanitizes a token id so it cannot escape the approvals directory.
 *
 * Token ids are UUIDs in the normal flow, but the CLI receives them from argv
 * so we treat them as untrusted input.
 */
function safeFilename(tokenId: string): string {
    if (!/^[a-zA-Z0-9_\-]+$/.test(tokenId)) {
        throw new Error(`Invalid token id: ${tokenId}`);
    }
    return `${tokenId}.json`;
}

/** File-backed implementation of the {@link ITokenStore} contract. */
export class DiskTokenStore implements ITokenStore {
    private readonly dir: string;

    constructor(dir: string = approvalsDir()) {
        this.dir = dir;
        mkdirSync(this.dir, { recursive: true });
    }

    get(tokenId: string): ApprovalToken | undefined {
        const path = join(this.dir, safeFilename(tokenId));
        if (!existsSync(path)) return undefined;
        try {
            const raw = readFileSync(path, 'utf8');
            const parsed = JSON.parse(raw) as ApprovalToken;
            if (parsed != null && typeof parsed === 'object' && typeof parsed.tokenId === 'string') {
                return {
                    ...parsed,
                    metadata: Object.freeze({ ...(parsed.metadata ?? {}) }),
                };
            }
        }
        catch {
            // A corrupt file is treated as a missing token; cleanup happens lazily.
            try { unlinkSync(path); } catch { /* swallow */ }
        }
        return undefined;
    }

    set(tokenId: string, token: ApprovalToken): void {
        const path = join(this.dir, safeFilename(tokenId));
        writeFileSync(path, `${JSON.stringify(token, null, 2)}\n`, 'utf8');
    }

    delete(tokenId: string): void {
        const path = join(this.dir, safeFilename(tokenId));
        try {
            unlinkSync(path);
        }
        catch (err: unknown) {
            const code = (err as { code?: string } | null)?.code;
            if (code !== 'ENOENT') throw err;
        }
    }

    *entries(): IterableIterator<[string, ApprovalToken]> {
        if (!existsSync(this.dir)) return;
        const files = readdirSync(this.dir);
        for (const file of files) {
            if (!file.endsWith('.json')) continue;
            const tokenId = file.slice(0, -'.json'.length);
            const token = this.get(tokenId);
            if (token != null) {
                yield [tokenId, token];
            }
        }
    }

    get size(): number {
        if (!existsSync(this.dir)) return 0;
        return readdirSync(this.dir).filter((f) => f.endsWith('.json')).length;
    }
}
