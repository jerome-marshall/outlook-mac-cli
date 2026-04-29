/**
 * `olk version` — report the CLI version and the upstream MCP version it was
 * ported from. Useful for bug reports.
 */

import { Command } from 'commander';

import { emitError, emitSuccess, type OutputOptions } from '../output.js';

const CLI_VERSION = '0.1.0';
const UPSTREAM_VERSION = '1.1.1';
const UPSTREAM_REPO = 'https://github.com/hasan-imam/mcp-outlook-applescript';

export function buildVersionCommand(getOutput: () => OutputOptions): Command {
    return new Command('version')
        .description('Print the CLI version and the upstream MCP version it was ported from.')
        .action(() => {
            try {
                emitSuccess({
                    cli: CLI_VERSION,
                    upstream: UPSTREAM_VERSION,
                    upstreamRepo: UPSTREAM_REPO,
                }, getOutput());
            }
            catch (err) {
                process.exit(emitError(err, getOutput()));
            }
        });
}
