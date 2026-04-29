/**
 * Argument-parsing helpers shared across all olk command groups.
 *
 * Each helper returns a typed value or throws a {@link ValidationError} so the
 * caller can surface a uniform error envelope. None of these helpers perform
 * I/O against Outlook — they are pure adapters between commander option
 * objects and the validated parameter shapes the upstream `tools` modules
 * expect.
 */

import { readFileSync } from 'node:fs';
import { ValidationError } from '../utils/errors.js';

/** Parses a string into a strictly positive integer or throws ValidationError. */
export function parsePositiveInt(value: string, name: string): number {
    const n = Number.parseInt(value, 10);
    if (!Number.isFinite(n) || n <= 0 || String(n) !== value.trim()) {
        throw new ValidationError(`${name} must be a positive integer (got ${JSON.stringify(value)})`);
    }
    return n;
}

/** Parses a string into a non-negative integer or throws ValidationError. */
export function parseNonNegativeInt(value: string, name: string): number {
    const n = Number.parseInt(value, 10);
    if (!Number.isFinite(n) || n < 0 || String(n) !== value.trim()) {
        throw new ValidationError(`${name} must be a non-negative integer (got ${JSON.stringify(value)})`);
    }
    return n;
}

/**
 * Returns the body string for outbound commands: prefers `--body`, falls back
 * to reading `--body-file` (or stdin when the path is `-`).
 */
export function resolveBody(
    body: string | undefined,
    bodyFile: string | undefined,
    name = 'body',
): string {
    if (body != null) return body;
    if (bodyFile == null) {
        throw new ValidationError(`Either --${name} or --${name}-file must be provided`);
    }
    if (bodyFile === '-') {
        return readStdinSync();
    }
    try {
        return readFileSync(bodyFile, 'utf8');
    }
    catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        throw new ValidationError(`Failed to read ${name} file ${JSON.stringify(bodyFile)}: ${message}`);
    }
}

/**
 * Reads stdin synchronously. Used when a body-style option is set to `-`.
 *
 * Synchronous because the CLI flow elsewhere is synchronous; the readFileSync
 * trick on '/dev/stdin' is the simplest portable form on macOS.
 */
function readStdinSync(): string {
    try {
        return readFileSync(0, 'utf8');
    }
    catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        throw new ValidationError(`Failed to read stdin: ${message}`);
    }
}

/** Splits a comma-separated CLI option into a trimmed, non-empty list. */
export function splitCsv(value: string | undefined): string[] | undefined {
    if (value == null) return undefined;
    const parts = value
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    return parts.length > 0 ? parts : undefined;
}

/** Reads ids from stdin (one per line, or comma separated) and returns positive integers. */
export function readIdsFromStdin(): number[] {
    const text = readStdinSync();
    const tokens = text
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    return tokens.map((tok) => parsePositiveInt(tok, 'id'));
}

/**
 * Repeatable commander handler — accumulates option values into an array.
 * Use as the third argument of `.option(..., collect, [])`.
 */
export function collect(value: string, previous: string[]): string[] {
    return previous.concat([value]);
}

/**
 * Parses a `cid=path` token used by `--inline-image` into a structured pair.
 */
export function parseInlineImage(token: string): { path: string; content_id: string } {
    const [contentId, ...rest] = token.split('=');
    if (contentId == null || contentId.length === 0 || rest.length === 0) {
        throw new ValidationError(`--inline-image must be of the form cid=path (got ${JSON.stringify(token)})`);
    }
    return { content_id: contentId, path: rest.join('=') };
}

/**
 * Parses an `--attach path[:displayname]` token. Display name is optional.
 */
export function parseAttachment(token: string): { path: string; name?: string } {
    const idx = token.indexOf(':');
    if (idx === -1) return { path: token };
    return { path: token.slice(0, idx), name: token.slice(idx + 1) };
}
