/**
 * Output formatting for the olk CLI.
 *
 * Every command writes either a success envelope to stdout or an error envelope
 * to stderr, then exits. Three output modes are supported:
 *
 *   - `json`   — pretty-printed JSON when stdout is a TTY, compact otherwise (default)
 *   - `ndjson` — one JSON object per line; for list responses, each item becomes its own line
 *   - `table`  — column-aligned text for human consumption
 *
 * The shape of the success envelope is the public contract with agents:
 *   `{ ok: true, data: <resource> }`
 *   `{ ok: true, data: { items, count, hasMore } }`  (for list/search results)
 * Error envelopes always look like:
 *   `{ ok: false, error: { code, message } }`
 */

import { wrapError, type ErrorCode } from '../utils/errors.js';

/** Output formats supported by every olk command. */
export type OutputFormat = 'json' | 'ndjson' | 'table';

/** Shared CLI-wide options threaded through every command. */
export interface OutputOptions {
    readonly format: OutputFormat;
    readonly noColor: boolean;
}

/** Successful result envelope written to stdout. */
export interface SuccessEnvelope<T> {
    readonly ok: true;
    readonly data: T;
}

/** Error envelope written to stderr. */
export interface ErrorEnvelope {
    readonly ok: false;
    readonly error: {
        readonly code: ErrorCode | string;
        readonly message: string;
    };
}

/** Standard pagination shape used by every list/search command. */
export interface ListPayload<T> {
    readonly items: readonly T[];
    readonly count: number;
    readonly hasMore: boolean;
}

/** Returns true when the writable stream looks like an interactive TTY. */
function isTty(stream: NodeJS.WriteStream): boolean {
    return Boolean(stream.isTTY);
}

/** Stringifies a payload as JSON, pretty when the target is a TTY and compact otherwise. */
function stringifyJson(value: unknown, stream: NodeJS.WriteStream): string {
    return isTty(stream) ? JSON.stringify(value, null, 2) : JSON.stringify(value);
}

/** True when the payload looks like a `{ items, count, hasMore }` page. */
function isListPayload(value: unknown): value is ListPayload<unknown> {
    return (
        value != null &&
        typeof value === 'object' &&
        Array.isArray((value as { items?: unknown }).items) &&
        typeof (value as { count?: unknown }).count === 'number' &&
        typeof (value as { hasMore?: unknown }).hasMore === 'boolean'
    );
}

/**
 * Writes a success envelope using the requested format and exits with code 0.
 */
export function emitSuccess<T>(data: T, options: OutputOptions): void {
    const stream = process.stdout;
    if (options.format === 'ndjson') {
        if (isListPayload(data)) {
            for (const item of data.items) {
                stream.write(`${JSON.stringify(item)}\n`);
            }
            return;
        }
        stream.write(`${JSON.stringify(data)}\n`);
        return;
    }
    if (options.format === 'table') {
        stream.write(`${renderTable(data)}\n`);
        return;
    }
    const envelope: SuccessEnvelope<T> = { ok: true, data };
    stream.write(`${stringifyJson(envelope, stream)}\n`);
}

/**
 * Writes an error envelope to stderr using a JSON shape suitable for branching
 * on `error.code`. The CLI always prints errors as JSON regardless of the
 * requested output format, so a misconfigured `--format` cannot hide failures.
 */
export function emitError(err: unknown, _options: OutputOptions): number {
    const wrapped = wrapError(err, 'An unexpected error occurred');
    const envelope: ErrorEnvelope = {
        ok: false,
        error: {
            code: wrapped.code,
            message: wrapped.message,
        },
    };
    const stream = process.stderr;
    stream.write(`${stringifyJson(envelope, stream)}\n`);
    return 1;
}

// ---------------------------------------------------------------------------
// Table rendering
// ---------------------------------------------------------------------------

/**
 * Renders an arbitrary value as a column-aligned ASCII table. Falls back to a
 * pretty-printed JSON dump for shapes the renderer doesn't understand.
 *
 * Keep this best-effort: agents pipe the JSON output, humans use `--table`.
 */
function renderTable(data: unknown): string {
    if (isListPayload(data)) {
        return renderRows(Array.from(data.items));
    }
    if (Array.isArray(data)) {
        return renderRows(data);
    }
    if (data != null && typeof data === 'object') {
        return renderKeyValue(data as Record<string, unknown>);
    }
    return String(data);
}

/** Formats a list of objects as a header + aligned rows. */
function renderRows(rows: readonly unknown[]): string {
    if (rows.length === 0) {
        return '(no items)';
    }
    if (typeof rows[0] !== 'object' || rows[0] == null) {
        return rows.map((r) => String(r)).join('\n');
    }
    const objects = rows as readonly Record<string, unknown>[];
    const columns = Array.from(
        objects.reduce<Set<string>>((acc, row) => {
            for (const key of Object.keys(row)) {
                acc.add(key);
            }
            return acc;
        }, new Set<string>()),
    );
    const widths = columns.map((col) => {
        const cellWidths = objects.map((row) => formatCell(row[col]).length);
        return Math.max(col.length, ...cellWidths);
    });
    const header = columns.map((col, i) => col.padEnd(widths[i])).join('  ');
    const sep = widths.map((w) => '-'.repeat(w)).join('  ');
    const body = objects
        .map((row) => columns.map((col, i) => formatCell(row[col]).padEnd(widths[i])).join('  '))
        .join('\n');
    return `${header}\n${sep}\n${body}`;
}

/** Formats a key/value object as two aligned columns. */
function renderKeyValue(obj: Record<string, unknown>): string {
    const keys = Object.keys(obj);
    if (keys.length === 0) {
        return '(empty)';
    }
    const keyWidth = Math.max(...keys.map((k) => k.length));
    return keys.map((k) => `${k.padEnd(keyWidth)}  ${formatCell(obj[k])}`).join('\n');
}

/** Renders a single cell value as a one-line string. */
function formatCell(value: unknown): string {
    if (value == null) return '';
    if (typeof value === 'string') return value.replace(/\s+/g, ' ').slice(0, 200);
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return JSON.stringify(value);
}
