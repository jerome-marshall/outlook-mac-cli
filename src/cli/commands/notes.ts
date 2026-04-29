/**
 * `olk notes` — read-only OneNote-style note operations.
 */

import { Command } from 'commander';

import { NotFoundError } from '../../utils/errors.js';
import { parseNonNegativeInt, parsePositiveInt } from '../argv.js';
import { emitError, emitSuccess, type OutputOptions } from '../output.js';
import type { Runtime } from '../runtime.js';

export function buildNotesCommand(runtime: Runtime, getOutput: () => OutputOptions): Command {
    const cmd = new Command('notes').description('Read Outlook notes.');

    cmd.command('list')
        .description('List notes with pagination.')
        .option('--limit <n>', 'Maximum results (1-100)', (v) => parsePositiveInt(v, '--limit'), 25)
        .option('--offset <n>', 'Pagination offset', (v) => parseNonNegativeInt(v, '--offset'), 0)
        .action((opts: { limit: number; offset: number }) => {
            try {
                const result = runtime.tools().notes.listNotes({ limit: opts.limit, offset: opts.offset });
                emitSuccess(result, getOutput());
            }
            catch (err) {
                process.exit(emitError(err, getOutput()));
            }
        });

    cmd.command('search <query>')
        .description('Search notes by title (does not search body content).')
        .option('--limit <n>', 'Maximum results (1-100)', (v) => parsePositiveInt(v, '--limit'), 25)
        .option('--offset <n>', 'Pagination offset', (v) => parseNonNegativeInt(v, '--offset'), 0)
        .action((query: string, opts: { limit: number; offset: number }) => {
            try {
                const result = runtime.tools().notes.searchNotes({ query, limit: opts.limit, offset: opts.offset });
                emitSuccess(result, getOutput());
            }
            catch (err) {
                process.exit(emitError(err, getOutput()));
            }
        });

    cmd.command('get <noteId>')
        .description('Get full note content.')
        .action((noteId: string) => {
            try {
                const note = runtime.tools().notes.getNote({ note_id: parsePositiveInt(noteId, 'note-id') });
                if (note == null) {
                    throw new NotFoundError('Note', parsePositiveInt(noteId, 'note-id'));
                }
                emitSuccess(note, getOutput());
            }
            catch (err) {
                process.exit(emitError(err, getOutput()));
            }
        });

    return cmd;
}
