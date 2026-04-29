/**
 * On-disk configuration store for `olk` (`~/.olk/config.json`).
 *
 * The CLI never relies on config existing — every persisted setting has a
 * default and an environment-variable override. The config is intended for
 * lightweight personalization (default folder, default output format).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { ValidationError } from '../utils/errors.js';

/** Shape of the on-disk config file. All fields are optional. */
export interface Config {
    defaultOutput?: 'json' | 'ndjson' | 'table' | 'toon';
    defaultFolder?: number;
    defaultAccount?: number;
}

/** Path to the config directory (~/.olk). */
export function configDir(): string {
    const override = process.env['OLK_HOME'];
    if (override != null && override.length > 0) {
        return override;
    }
    return join(homedir(), '.olk');
}

/** Path to the config file. */
export function configPath(): string {
    return join(configDir(), 'config.json');
}

/** Loads the on-disk config, returning an empty object if absent or corrupted. */
export function loadConfig(): Config {
    const path = configPath();
    if (!existsSync(path)) return {};
    try {
        const raw = readFileSync(path, 'utf8');
        const parsed = JSON.parse(raw) as unknown;
        if (parsed != null && typeof parsed === 'object') {
            return parsed as Config;
        }
    }
    catch {
        // Treat corrupt config as empty rather than failing every command.
    }
    return {};
}

/** Persists the config object to disk, creating the directory if needed. */
export function saveConfig(config: Config): void {
    const path = configPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

/** Returns the value of a config key, or undefined if unset. */
export function getConfigValue<K extends keyof Config>(key: K): Config[K] {
    const config = loadConfig();
    return config[key];
}

/**
 * Sets a config key, validating the value against the config shape.
 * Returns the updated config.
 */
export function setConfigValue(key: string, rawValue: string): Config {
    const config = loadConfig();
    switch (key) {
        case 'defaultOutput': {
            if (rawValue !== 'json' && rawValue !== 'ndjson' && rawValue !== 'table' && rawValue !== 'toon') {
                throw new ValidationError(`defaultOutput must be one of: json, ndjson, table, toon (got ${JSON.stringify(rawValue)})`);
            }
            config.defaultOutput = rawValue;
            break;
        }
        case 'defaultFolder': {
            const n = Number.parseInt(rawValue, 10);
            if (!Number.isFinite(n) || n <= 0) {
                throw new ValidationError(`defaultFolder must be a positive integer (got ${JSON.stringify(rawValue)})`);
            }
            config.defaultFolder = n;
            break;
        }
        case 'defaultAccount': {
            const n = Number.parseInt(rawValue, 10);
            if (!Number.isFinite(n) || n <= 0) {
                throw new ValidationError(`defaultAccount must be a positive integer (got ${JSON.stringify(rawValue)})`);
            }
            config.defaultAccount = n;
            break;
        }
        default:
            throw new ValidationError(`Unknown config key: ${key}`);
    }
    saveConfig(config);
    return config;
}

/** Removes a config key. Returns the updated config. */
export function unsetConfigValue(key: string): Config {
    const config = loadConfig();
    if (!(key in config)) return config;
    delete (config as Record<string, unknown>)[key];
    saveConfig(config);
    return config;
}
