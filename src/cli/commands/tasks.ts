/**
 * `olk tasks` — read-only task operations.
 */

import { Command } from 'commander';

import { NotFoundError } from '../../utils/errors.js';
import { parseNonNegativeInt, parsePositiveInt } from '../argv.js';
import { emitError, emitSuccess, type OutputOptions } from '../output.js';
import type { Runtime } from '../runtime.js';

export function buildTasksCommand(runtime: Runtime, getOutput: () => OutputOptions): Command {
    const cmd = new Command('tasks').description('Read Outlook tasks (To Do).');

    cmd.command('list')
        .description('List tasks with pagination.')
        .option('--limit <n>', 'Maximum results (1-100)', (v) => parsePositiveInt(v, '--limit'), 25)
        .option('--offset <n>', 'Pagination offset', (v) => parseNonNegativeInt(v, '--offset'), 0)
        .option('--incomplete', 'Only return incomplete tasks', false)
        .action((opts: { limit: number; offset: number; incomplete: boolean }) => {
            try {
                const result = runtime.tools().tasks.listTasks({
                    limit: opts.limit,
                    offset: opts.offset,
                    include_completed: !opts.incomplete,
                });
                emitSuccess(result, getOutput());
            }
            catch (err) {
                process.exit(emitError(err, getOutput()));
            }
        });

    cmd.command('search <query>')
        .description('Search tasks by name.')
        .option('--limit <n>', 'Maximum results (1-100)', (v) => parsePositiveInt(v, '--limit'), 25)
        .option('--offset <n>', 'Pagination offset', (v) => parseNonNegativeInt(v, '--offset'), 0)
        .action((query: string, opts: { limit: number; offset: number }) => {
            try {
                const result = runtime.tools().tasks.searchTasks({ query, limit: opts.limit, offset: opts.offset });
                emitSuccess(result, getOutput());
            }
            catch (err) {
                process.exit(emitError(err, getOutput()));
            }
        });

    cmd.command('get <taskId>')
        .description('Get full task details.')
        .action((taskId: string) => {
            try {
                const task = runtime.tools().tasks.getTask({ task_id: parsePositiveInt(taskId, 'task-id') });
                if (task == null) {
                    throw new NotFoundError('Task', parsePositiveInt(taskId, 'task-id'));
                }
                emitSuccess(task, getOutput());
            }
            catch (err) {
                process.exit(emitError(err, getOutput()));
            }
        });

    return cmd;
}
