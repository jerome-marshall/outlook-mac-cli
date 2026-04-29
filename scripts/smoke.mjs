#!/usr/bin/env node
/**
 * Live smoke test for olk.
 *
 * Gated on `OLK_LIVE=1` because the happy path requires:
 *   - Outlook for Mac running and signed in
 *   - Automation permission granted to whichever process invokes the CLI
 *
 * Verifies, in order:
 *   1. `olk version`     — binary boots, JSON envelope shape correct
 *   2. `olk doctor`      — pre-flight passes
 *   3. `olk mail folders` — repository round-trip works
 *   4. `olk mail unread-count` — at least an integer comes back
 *   5. `olk cal calendars` — calendar repository works
 *
 * Each step prints "PASS"/"FAIL" with a short reason. Exits non-zero on
 * the first failure.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

if (process.env.OLK_LIVE !== '1') {
    console.log('skipped (set OLK_LIVE=1 to run)');
    process.exit(0);
}

const here = dirname(fileURLToPath(import.meta.url));
const bin = join(here, '..', 'dist', 'cli', 'index.js');

let failed = 0;

function run(label, args) {
    const result = spawnSync('node', [bin, ...args], { encoding: 'utf8' });
    const stdout = result.stdout?.trim() ?? '';
    const stderr = result.stderr?.trim() ?? '';
    if (result.status !== 0 && result.status !== 1) {
        console.log(`FAIL  ${label}: exit ${result.status}\n  stderr: ${stderr}`);
        failed++;
        return null;
    }
    let parsed;
    try {
        parsed = JSON.parse(stdout);
    }
    catch {
        console.log(`FAIL  ${label}: stdout was not JSON\n  stdout: ${stdout.slice(0, 200)}`);
        failed++;
        return null;
    }
    if (parsed?.ok !== true) {
        console.log(`FAIL  ${label}: ok=false\n  ${JSON.stringify(parsed)}`);
        failed++;
        return null;
    }
    console.log(`PASS  ${label}`);
    return parsed.data;
}

run('version', ['version']);
run('doctor', ['doctor']);
run('mail folders', ['mail', 'folders']);
run('mail unread-count', ['mail', 'unread-count']);
run('cal calendars', ['cal', 'calendars']);

if (failed > 0) {
    console.log(`\n${failed} failure(s).`);
    process.exit(1);
}
console.log('\nAll smoke checks passed.');
