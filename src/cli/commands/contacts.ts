/**
 * `olk contacts` — read-only contact operations.
 */

import { Command } from 'commander';

import { NotFoundError } from '../../utils/errors.js';
import { parseNonNegativeInt, parsePositiveInt } from '../argv.js';
import { emitError, emitSuccess, type OutputOptions } from '../output.js';
import type { Runtime } from '../runtime.js';

export function buildContactsCommand(runtime: Runtime, getOutput: () => OutputOptions): Command {
    const cmd = new Command('contacts').description('Read Outlook contacts.');

    cmd.command('list')
        .description('List contact summaries with pagination.')
        .option('--limit <n>', 'Maximum results (1-100)', (v) => parsePositiveInt(v, '--limit'), 25)
        .option('--offset <n>', 'Pagination offset', (v) => parseNonNegativeInt(v, '--offset'), 0)
        .action((opts: { limit: number; offset: number }) => {
            try {
                const result = runtime.tools().contacts.listContacts({ limit: opts.limit, offset: opts.offset });
                emitSuccess(result, getOutput());
            }
            catch (err) {
                process.exit(emitError(err, getOutput()));
            }
        });

    cmd.command('search <query>')
        .description('Search contacts by name.')
        .option('--limit <n>', 'Maximum results (1-100)', (v) => parsePositiveInt(v, '--limit'), 25)
        .option('--offset <n>', 'Pagination offset', (v) => parseNonNegativeInt(v, '--offset'), 0)
        .action((query: string, opts: { limit: number; offset: number }) => {
            try {
                const result = runtime.tools().contacts.searchContacts({ query, limit: opts.limit, offset: opts.offset });
                emitSuccess(result, getOutput());
            }
            catch (err) {
                process.exit(emitError(err, getOutput()));
            }
        });

    cmd.command('get <contactId>')
        .description('Get full contact details.')
        .action((contactId: string) => {
            try {
                const contact = runtime.tools().contacts.getContact({ contact_id: parsePositiveInt(contactId, 'contact-id') });
                if (contact == null) {
                    throw new NotFoundError('Contact', parsePositiveInt(contactId, 'contact-id'));
                }
                emitSuccess(contact, getOutput());
            }
            catch (err) {
                process.exit(emitError(err, getOutput()));
            }
        });

    return cmd;
}
