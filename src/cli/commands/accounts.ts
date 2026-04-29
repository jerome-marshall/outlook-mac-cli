/**
 * `olk accounts` — list configured Outlook accounts.
 */

import { Command } from 'commander';

import { emitError, emitSuccess, type OutputOptions } from '../output.js';
import type { Runtime } from '../runtime.js';

export function buildAccountsCommand(runtime: Runtime, getOutput: () => OutputOptions): Command {
    const cmd = new Command('accounts').description('Inspect Outlook accounts.');

    cmd.command('list')
        .description('List all mail accounts configured in Microsoft Outlook for Mac.')
        .action(() => {
            try {
                const tools = runtime.tools();
                const accounts = tools.accountRepository.listAccounts();
                const defaultId = tools.accountRepository.getDefaultAccountId();
                emitSuccess({
                    items: accounts.map((acc) => ({
                        id: acc.id,
                        name: acc.name,
                        email: acc.email,
                        type: acc.type,
                        isDefault: acc.id === defaultId,
                    })),
                    count: accounts.length,
                    hasMore: false,
                }, getOutput());
            }
            catch (err) {
                process.exit(emitError(err, getOutput()));
            }
        });

    cmd.command('default')
        .description('Print the default account id.')
        .action(() => {
            try {
                const id = runtime.tools().accountRepository.getDefaultAccountId();
                emitSuccess({ id }, getOutput());
            }
            catch (err) {
                process.exit(emitError(err, getOutput()));
            }
        });

    return cmd;
}
