/**
 * `olk config` — manage `~/.olk/config.json`.
 */

import { Command } from 'commander';

import { ValidationError } from '../../utils/errors.js';
import { emitError, emitSuccess, type OutputOptions } from '../output.js';
import { configPath, loadConfig, setConfigValue, unsetConfigValue } from '../config.js';

export function buildConfigCommand(getOutput: () => OutputOptions): Command {
    const cmd = new Command('config').description('Read, update, and inspect the olk config file.');

    cmd.command('get [key]')
        .description('Print one config key, or the entire config when no key is given.')
        .action((key?: string) => {
            try {
                const config = loadConfig();
                if (key == null) {
                    emitSuccess(config, getOutput());
                    return;
                }
                if (!(key in config)) {
                    throw new ValidationError(`Config key not set: ${key}`);
                }
                emitSuccess({ [key]: (config as Record<string, unknown>)[key] }, getOutput());
            }
            catch (err) {
                process.exit(emitError(err, getOutput()));
            }
        });

    cmd.command('set <key> <value>')
        .description('Set a config key. Supported keys: defaultOutput, defaultFolder, defaultAccount.')
        .action((key: string, value: string) => {
            try {
                const config = setConfigValue(key, value);
                emitSuccess(config, getOutput());
            }
            catch (err) {
                process.exit(emitError(err, getOutput()));
            }
        });

    cmd.command('unset <key>')
        .description('Remove a config key.')
        .action((key: string) => {
            try {
                const config = unsetConfigValue(key);
                emitSuccess(config, getOutput());
            }
            catch (err) {
                process.exit(emitError(err, getOutput()));
            }
        });

    cmd.command('path')
        .description('Print the config file path.')
        .action(() => {
            try {
                emitSuccess({ path: configPath() }, getOutput());
            }
            catch (err) {
                process.exit(emitError(err, getOutput()));
            }
        });

    return cmd;
}
