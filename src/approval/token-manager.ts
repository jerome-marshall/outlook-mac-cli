import { randomUUID } from 'node:crypto';
import type { OperationType, TargetType, ApprovalToken, ValidationResult } from './types.js';

// =============================================================================
// Constants
// =============================================================================

/** Tokens expire after 5 minutes by default. */
const DEFAULT_TTL_MS = 5 * 60 * 1000;

/** Triggers garbage collection of expired tokens when the store exceeds this size. */
const CLEANUP_THRESHOLD = 100;

// =============================================================================
// Token Store interface
// =============================================================================

/**
 * Pluggable backing store for approval tokens.
 *
 * The MCP upstream uses an in-process Map; the CLI swaps in a disk-backed
 * implementation so prepare and confirm can run in different processes.
 *
 * Implementations must be synchronous; the public TokenManager surface is
 * synchronous and we keep that contract intact.
 */
export interface ITokenStore {
    /** Returns the token for a given id, or undefined if missing. */
    get(tokenId: string): ApprovalToken | undefined;
    /** Persists a token, overwriting any existing value with the same id. */
    set(tokenId: string, token: ApprovalToken): void;
    /** Removes a token by id. */
    delete(tokenId: string): void;
    /** Iterates all tokens currently held in the store. */
    entries(): IterableIterator<[string, ApprovalToken]>;
    /** Number of tokens currently held (includes expired tokens not yet purged). */
    readonly size: number;
}

/** Default in-memory store used by the upstream tests and the MCP code. */
export class InMemoryTokenStore implements ITokenStore {
    private readonly tokens = new Map<string, ApprovalToken>();

    get(tokenId: string): ApprovalToken | undefined {
        return this.tokens.get(tokenId);
    }
    set(tokenId: string, token: ApprovalToken): void {
        this.tokens.set(tokenId, token);
    }
    delete(tokenId: string): void {
        this.tokens.delete(tokenId);
    }
    entries(): IterableIterator<[string, ApprovalToken]> {
        return this.tokens.entries();
    }
    get size(): number {
        return this.tokens.size;
    }
}

// =============================================================================
// Token Manager
// =============================================================================

/**
 * Single-use approval token manager backed by a pluggable {@link ITokenStore}.
 *
 * Each token authorizes exactly one destructive operation on one target.
 * Tokens are automatically purged once the store exceeds CLEANUP_THRESHOLD.
 *
 * The default constructor preserves the upstream MCP behaviour
 * (in-memory store, 5 minute TTL); the CLI passes a disk-backed store and a
 * configurable TTL so prepare/confirm can run across separate processes.
 */
export class ApprovalTokenManager {
    private readonly store: ITokenStore;
    private readonly ttlMs: number;

    constructor(ttlMs: number = DEFAULT_TTL_MS, store: ITokenStore = new InMemoryTokenStore()) {
        this.ttlMs = ttlMs;
        this.store = store;
    }

    /** Creates and stores a new approval token for the given operation and target. */
    generateToken(params: {
        operation: OperationType;
        targetType: TargetType;
        targetId: number;
        targetHash: string;
        metadata?: Record<string, unknown>;
    }): ApprovalToken {
        if (this.store.size > CLEANUP_THRESHOLD) {
            this.cleanupExpiredTokens();
        }
        const now = Date.now();
        const token: ApprovalToken = {
            tokenId: randomUUID(),
            operation: params.operation,
            targetType: params.targetType,
            targetId: params.targetId,
            targetHash: params.targetHash,
            createdAt: now,
            expiresAt: now + this.ttlMs,
            metadata: Object.freeze({ ...params.metadata }),
        };
        this.store.set(token.tokenId, token);
        return token;
    }

    /** Checks a token's validity without consuming it. Verifies existence, expiry, operation, and target. */
    validateToken(tokenId: string, operation: OperationType, targetId: number): ValidationResult {
        const token = this.store.get(tokenId);
        if (token == null) {
            return { valid: false, error: 'NOT_FOUND' };
        }
        if (Date.now() > token.expiresAt) {
            return { valid: false, error: 'EXPIRED' };
        }
        if (token.operation !== operation) {
            return { valid: false, error: 'OPERATION_MISMATCH' };
        }
        if (token.targetId !== targetId) {
            return { valid: false, error: 'TARGET_MISMATCH' };
        }
        return { valid: true, token };
    }

    /** Validates a token and removes it from the store on success (one-time use). */
    consumeToken(tokenId: string, operation: OperationType, targetId: number): ValidationResult {
        const result = this.validateToken(tokenId, operation, targetId);
        if (result.valid) {
            this.store.delete(tokenId);
        }
        return result;
    }

    /** Purges all expired tokens from the underlying store. */
    cleanupExpiredTokens(): void {
        const now = Date.now();
        for (const [tokenId, token] of this.store.entries()) {
            if (now > token.expiresAt) {
                this.store.delete(tokenId);
            }
        }
    }

    /** Number of tokens currently held (includes expired tokens not yet purged). */
    get size(): number {
        return this.store.size;
    }
}
