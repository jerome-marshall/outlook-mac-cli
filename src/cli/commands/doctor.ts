/**
 * `olk doctor` — pre-flight check for the CLI.
 *
 * Reports each requirement independently so an agent can branch on the first
 * failing prerequisite without scraping prose.
 */

import { Command } from 'commander';

import { isOutlookRunning, executeAppleScript } from '../../applescript/index.js';
import { emitError, emitSuccess, type OutputOptions } from '../output.js';

interface DoctorReport {
    platform: { ok: boolean; value: string };
    nodeVersion: { ok: boolean; value: string; required: string };
    outlookRunning: { ok: boolean; hint?: string };
    automationPermission: { ok: boolean; hint?: string };
}

function checkPlatform(): DoctorReport['platform'] {
    return { ok: process.platform === 'darwin', value: process.platform };
}

function checkNode(): DoctorReport['nodeVersion'] {
    const major = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
    return {
        ok: major >= 20,
        value: process.versions.node,
        required: '>=20.0.0',
    };
}

function checkOutlookRunning(): DoctorReport['outlookRunning'] {
    if (isOutlookRunning()) return { ok: true };
    return {
        ok: false,
        hint: 'Outlook is not running. Start it with: open -a "Microsoft Outlook"',
    };
}

function checkAutomationPermission(): DoctorReport['automationPermission'] {
    // Cheap probe: try to read the application name. Permission denial returns a
    // distinctive error from osascript; not-running returns a different one and
    // is reported separately.
    const probe = executeAppleScript('tell application "Microsoft Outlook" to get name');
    if (probe.success) return { ok: true };
    const err = (probe.error ?? '').toLowerCase();
    if (/not authorized|permission denied|assistive access/.test(err)) {
        return {
            ok: false,
            hint: 'Grant Automation permission for Microsoft Outlook in System Settings > Privacy & Security > Automation.',
        };
    }
    if (/not running|application isn't running/.test(err)) {
        return { ok: false, hint: 'Outlook is not running; cannot verify automation permission.' };
    }
    return { ok: false, hint: probe.error ?? 'Unknown osascript error' };
}

export function buildDoctorCommand(getOutput: () => OutputOptions): Command {
    return new Command('doctor')
        .description('Verify Outlook installation, automation permission, and Node version.')
        .action(() => {
            try {
                const report: DoctorReport = {
                    platform: checkPlatform(),
                    nodeVersion: checkNode(),
                    outlookRunning: checkOutlookRunning(),
                    automationPermission: checkAutomationPermission(),
                };
                const allOk = Object.values(report).every((c) => c.ok);
                emitSuccess({ ok: allOk, ...report }, getOutput());
                process.exit(allOk ? 0 : 1);
            }
            catch (err) {
                process.exit(emitError(err, getOutput()));
            }
        });
}
