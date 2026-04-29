#!/usr/bin/env node
/**
 * `olk` — Outlook for Mac CLI.
 *
 * Wires every upstream tool surface (mail, calendar, contacts, tasks, notes,
 * mailbox-organization, accounts, send, calendar-writer, calendar-manager)
 * onto a commander-based subcommand tree. Output goes through a JSON-first
 * envelope (see {@link ./output.ts}) so agents can pipe results through `jq`.
 *
 * The runtime is lazy: command-not-found, `--help`, `version`, and `doctor`
 * paths never construct the AppleScript backend, so they work on machines
 * that don't have Outlook installed.
 */

import { Command, InvalidArgumentError } from 'commander';

import { Runtime } from './runtime.js';
import { emitError, type OutputOptions, type OutputFormat } from './output.js';
import { loadConfig } from './config.js';

import { buildAccountsCommand } from './commands/accounts.js';
import { buildCalCommand } from './commands/cal.js';
import { buildConfigCommand } from './commands/config.js';
import { buildContactsCommand } from './commands/contacts.js';
import { buildDoctorCommand } from './commands/doctor.js';
import { buildFolderCommand } from './commands/folder.js';
import { buildMailCommand } from './commands/mail.js';
import { buildNotesCommand } from './commands/notes.js';
import { buildTasksCommand } from './commands/tasks.js';
import { buildVersionCommand } from './commands/version.js';

const CLI_VERSION = '0.1.0';

/** Builds the root commander program and binds every subcommand. */
export function buildProgram(runtimeFactory: () => Runtime = () => new Runtime()): Command {
    let runtime: Runtime | null = null;
    const getRuntime = (): Runtime => {
        if (runtime == null) runtime = runtimeFactory();
        return runtime;
    };

    const config = loadConfig();
    const defaults: OutputOptions = {
        format: resolveDefaultFormat(config.defaultOutput),
        noColor: process.env['OLK_NO_COLOR'] === '1' || process.env['OLK_NO_COLOR'] === 'true',
    };

    const program = new Command()
        .name('olk')
        .description('Outlook for Mac CLI for AI agents and humans alike.')
        .version(CLI_VERSION, '-v, --version', 'Print the CLI version and exit.')
        .option('--json', 'Emit pretty/compact JSON (default)')
        .option('--ndjson', 'Emit one JSON object per line; lists yield one item per line')
        .option('--table', 'Emit a column-aligned text table for human consumption')
        .option('--no-color', 'Disable ANSI color codes (currently a no-op; reserved for future use)')
        .showHelpAfterError()
        .helpOption('-h, --help', 'Display help for this command');

    /**
     * Resolves the output options from the active commander program at call
     * time. Subcommands wire this getter rather than capturing the value
     * eagerly so `--ndjson` placed after a subcommand still wins.
     */
    const getOutput = (): OutputOptions => {
        const opts = program.opts();
        const format: OutputFormat =
            opts['ndjson'] === true ? 'ndjson'
                : opts['table'] === true ? 'table'
                    : opts['json'] === true ? 'json'
                        : defaults.format;
        const noColor = opts['color'] === false || defaults.noColor;
        return { format, noColor };
    };

    program.addCommand(buildVersionCommand(getOutput));
    program.addCommand(buildDoctorCommand(getOutput));
    program.addCommand(buildConfigCommand(getOutput));
    program.addCommand(buildAccountsCommand(getRuntime(), getOutput));
    program.addCommand(buildMailCommand(getRuntime(), getOutput));
    program.addCommand(buildCalCommand(getRuntime(), getOutput));
    program.addCommand(buildContactsCommand(getRuntime(), getOutput));
    program.addCommand(buildTasksCommand(getRuntime(), getOutput));
    program.addCommand(buildNotesCommand(getRuntime(), getOutput));
    program.addCommand(buildFolderCommand(getRuntime(), getOutput));

    return program;
}

function resolveDefaultFormat(value: string | undefined): OutputFormat {
    if (value === 'json' || value === 'ndjson' || value === 'table') return value;
    return 'json';
}

async function main(): Promise<void> {
    const program = buildProgram();
    try {
        await program.parseAsync(process.argv);
    }
    catch (err: unknown) {
        // commander throws InvalidArgumentError for our coerce callbacks.
        // Treat parser errors as validation failures with a JSON envelope.
        const code = err instanceof InvalidArgumentError ? 'VALIDATION_ERROR' : 'UNKNOWN';
        process.exit(emitError(
            { code, message: err instanceof Error ? err.message : String(err) },
            { format: 'json', noColor: false },
        ));
    }
}

const isMainModule = import.meta.url === `file://${process.argv[1]}` ||
    import.meta.url.endsWith('/dist/cli/index.js');
if (isMainModule) {
    main().catch((error: unknown) => {
        process.stderr.write(`${JSON.stringify({ ok: false, error: { code: 'UNKNOWN', message: error instanceof Error ? error.message : String(error) } })}\n`);
        process.exit(1);
    });
}
