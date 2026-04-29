#!/usr/bin/env node
/**
 * Comprehensive verification harness for the olk CLI.
 *
 * Walks every command group end-to-end, asserting:
 *   1. The success envelope shape `{ ok: true, data: ... }`
 *   2. The error envelope shape `{ ok: false, error: { code, message } }`
 *   3. Mutating ops round-trip back to their initial state
 *
 * Side-effect policy:
 *   - SKIPS `olk mail send` (would dispatch real email)
 *   - SKIPS `olk cal create` (would create a real event)
 *   - Mark/flag/categories on a test email are toggled then restored
 *   - Folder create + prepare/confirm-delete is a self-cleaning round trip
 *   - Approval prepare paths route through OLK_HOME=tmpdir so the user's
 *     real ~/.olk/approvals/ store stays untouched
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const bin = join(here, '..', 'dist', 'cli', 'index.js');

const sandbox = mkdtempSync(join(tmpdir(), 'olk-verify-'));
process.on('exit', () => {
    try { rmSync(sandbox, { recursive: true, force: true }); } catch { /* ignore */ }
});

let pass = 0;
let fail = 0;
const failures = [];

/**
 * Runs `olk <args...>` and returns `{ exitCode, parsed, stdout, stderr }`.
 *
 * Always parses stdout as JSON (or stderr if exit is non-zero) so callers can
 * branch on the envelope shape rather than scraping prose.
 */
function olk(args, { input, env } = {}) {
    const result = spawnSync('node', [bin, ...args], {
        encoding: 'utf8',
        input,
        env: { ...process.env, OLK_HOME: sandbox, ...env },
    });
    const stdout = result.stdout?.trim() ?? '';
    const stderr = result.stderr?.trim() ?? '';
    let parsed;
    const target = result.status === 0 ? stdout : stderr || stdout;
    if (target.length > 0) {
        try { parsed = JSON.parse(target); }
        catch { /* leave undefined */ }
    }
    return { exitCode: result.status, parsed, stdout, stderr };
}

/** Asserts a condition and records it in the running tally. */
function check(label, condition, detail) {
    if (condition) {
        console.log(`  PASS  ${label}`);
        pass++;
    }
    else {
        console.log(`  FAIL  ${label}${detail != null ? ` (${detail})` : ''}`);
        fail++;
        failures.push(label);
    }
}

function section(title) {
    console.log(`\n=== ${title} ===`);
}

function assertSuccess(res, label) {
    check(label, res.exitCode === 0 && res.parsed?.ok === true, `exit=${res.exitCode}, stdout=${res.stdout.slice(0, 120)}, stderr=${res.stderr.slice(0, 120)}`);
}

function assertError(res, expectedCode, label) {
    const ok = res.exitCode !== 0 && res.parsed?.ok === false && res.parsed?.error?.code === expectedCode;
    check(label, ok, `expected ${expectedCode}, got exit=${res.exitCode}, parsed=${JSON.stringify(res.parsed)}`);
}

// ---------------------------------------------------------------------------
// 1. Discovery + meta
// ---------------------------------------------------------------------------
section('Discovery + meta');
{
    const v = olk(['version']);
    assertSuccess(v, 'olk version');
    check('version.cli is a string', typeof v.parsed?.data?.cli === 'string');
    check('version.upstream is a string', typeof v.parsed?.data?.upstream === 'string');

    const d = olk(['doctor']);
    assertSuccess(d, 'olk doctor');
    check('doctor.platform.ok', d.parsed?.data?.platform?.ok === true);
    check('doctor.outlookRunning.ok', d.parsed?.data?.outlookRunning?.ok === true);
    check('doctor.automationPermission.ok', d.parsed?.data?.automationPermission?.ok === true);

    const help = spawnSync('node', [bin, '--help'], { encoding: 'utf8' });
    check('--help exits 0', help.status === 0);
    check('--help lists all command groups',
        ['mail', 'cal', 'contacts', 'tasks', 'notes', 'folder', 'accounts', 'doctor', 'version', 'config']
            .every((g) => help.stdout.includes(g)));
}

// ---------------------------------------------------------------------------
// 2. Accounts
// ---------------------------------------------------------------------------
section('Accounts');
{
    const list = olk(['accounts', 'list']);
    assertSuccess(list, 'accounts list');
    check('accounts list returns paginated shape',
        Array.isArray(list.parsed?.data?.items) && typeof list.parsed?.data?.count === 'number');

    const dflt = olk(['accounts', 'default']);
    assertSuccess(dflt, 'accounts default');
}

// ---------------------------------------------------------------------------
// 3. Config
// ---------------------------------------------------------------------------
section('Config');
{
    const empty = olk(['config', 'get']);
    assertSuccess(empty, 'config get (empty)');
    check('config starts empty', JSON.stringify(empty.parsed?.data) === '{}');

    const bad = olk(['config', 'set', 'defaultOutput', 'csv']);
    assertError(bad, 'VALIDATION_ERROR', 'config rejects invalid output value');

    // Force --json so this assertion isn't sensitive to config state set in
    // a previous step (the on-disk default is read at process start).
    const set = olk(['config', '--json', 'set', 'defaultOutput', 'ndjson']);
    assertSuccess(set, 'config set defaultOutput ndjson');
    check('config persists value', set.parsed?.data?.defaultOutput === 'ndjson');

    const unset = olk(['--json', 'config', 'unset', 'defaultOutput']);
    assertSuccess(unset, 'config unset defaultOutput');
    check('config unset removes key', unset.parsed?.data?.defaultOutput === undefined);
}

// ---------------------------------------------------------------------------
// 4. Mail read paths
// ---------------------------------------------------------------------------
section('Mail read paths');
let inboxId = null;
let knownEmailId = null;
let attachmentEmailId = null;
{
    const folders = olk(['mail', 'folders']);
    assertSuccess(folders, 'mail folders');
    const inbox = folders.parsed?.data?.items?.find((f) => f.name === 'Inbox' && f.messageCount === 0 && f.unreadCount > 0)
                ?? folders.parsed?.data?.items?.find((f) => f.name === 'Inbox' && (f.unreadCount > 0 || f.messageCount > 0))
                ?? folders.parsed?.data?.items?.find((f) => f.name === 'Inbox');
    inboxId = inbox?.id ?? null;
    check('mail folders includes an Inbox', inboxId != null);

    const all = olk(['mail', 'folders', '--account-id', 'all']);
    assertSuccess(all, 'mail folders --account-id all');

    if (inboxId != null) {
        const list = olk(['mail', 'list', '--folder', String(inboxId), '--limit', '5']);
        assertSuccess(list, `mail list --folder ${inboxId} --limit 5`);
        check('mail list returns items array', Array.isArray(list.parsed?.data?.items));
        check('mail list respects --limit', (list.parsed?.data?.items?.length ?? 0) <= 5);
        knownEmailId = list.parsed?.data?.items?.[0]?.id ?? null;
        attachmentEmailId = list.parsed?.data?.items?.find((m) => m.hasAttachment === true)?.id ?? null;

        const unread = olk(['mail', 'list', '--folder', String(inboxId), '--limit', '5', '--unread']);
        assertSuccess(unread, 'mail list --unread');
        check('mail list --unread returns only unread', (unread.parsed?.data?.items ?? []).every((m) => m.isRead === false));

        const shorthand = olk(['mail', 'unread', '--folder', String(inboxId), '--limit', '3']);
        assertSuccess(shorthand, 'mail unread shorthand');

        const dated = olk(['mail', 'list', '--folder', String(inboxId), '--limit', '5', '--after', '2020-01-01T00:00:00Z']);
        assertSuccess(dated, 'mail list --after');

        const u = olk(['mail', 'unread-count']);
        assertSuccess(u, 'mail unread-count (global)');
        check('global unread-count is integer', Number.isInteger(u.parsed?.data?.count));

        const uf = olk(['mail', 'unread-count', '--folder', String(inboxId)]);
        assertSuccess(uf, 'mail unread-count --folder');
    }

    if (knownEmailId != null) {
        const read = olk(['mail', 'read', String(knownEmailId)]);
        assertSuccess(read, `mail read ${knownEmailId}`);
        check('mail read returns subject field', 'subject' in (read.parsed?.data ?? {}));
        check('mail read returns attachments array', Array.isArray(read.parsed?.data?.attachments));

        const noBody = olk(['mail', 'read', String(knownEmailId), '--no-body']);
        assertSuccess(noBody, 'mail read --no-body');
        check('mail read --no-body strips body', noBody.parsed?.data?.body == null);
    }

    const search = olk(['mail', 'search', 're', '--limit', '3']);
    assertSuccess(search, 'mail search "re"');
    check('mail search returns paginated shape', Array.isArray(search.parsed?.data?.items));

    const missing = olk(['mail', 'read', '999999999']);
    assertError(missing, 'NOT_FOUND', 'mail read on unknown id returns NOT_FOUND');

    if (attachmentEmailId != null) {
        const atts = olk(['mail', 'attachments', String(attachmentEmailId)]);
        assertSuccess(atts, `mail attachments on email ${attachmentEmailId}`);
    }
    else {
        console.log('  SKIP  mail attachments (no email with attachments in first page)');
    }
}

// ---------------------------------------------------------------------------
// 5. Output formats (same query, three formats)
// ---------------------------------------------------------------------------
section('Output formats');
if (inboxId != null) {
    const args = ['mail', 'list', '--folder', String(inboxId), '--limit', '2'];

    const j = olk([...args, '--json']);
    assertSuccess(j, '--json envelope');

    const n = olk([...args, '--ndjson']);
    check('--ndjson exits 0', n.exitCode === 0);
    const lines = n.stdout.split('\n').filter((l) => l.length > 0);
    check('--ndjson emits one item per line', lines.length <= 2 && lines.every((l) => {
        try { JSON.parse(l); return true; } catch { return false; }
    }));

    const t = olk([...args, '--table']);
    check('--table exits 0', t.exitCode === 0);
    check('--table emits a header row', /id\s+folderId/.test(t.stdout));
}

// ---------------------------------------------------------------------------
// 6. Mutating mail ops (toggle and revert)
// ---------------------------------------------------------------------------
section('Mail mark / flag / categories (toggle + revert)');
if (knownEmailId != null) {
    // Snapshot current state.
    const before = olk(['mail', 'read', String(knownEmailId), '--no-body']);
    const wasRead = before.parsed?.data?.isRead === true;
    const wasFlag = before.parsed?.data?.flagStatus ?? 0;
    const wasCats = before.parsed?.data?.categories ?? [];

    // mark
    const toUnread = olk(['mail', 'mark', String(knownEmailId), wasRead ? 'unread' : 'read']);
    assertSuccess(toUnread, `mail mark ${wasRead ? 'unread' : 'read'}`);
    const flipped = olk(['mail', 'read', String(knownEmailId), '--no-body']);
    check('mark flipped read state', flipped.parsed?.data?.isRead !== wasRead);
    const restoreMark = olk(['mail', 'mark', String(knownEmailId), wasRead ? 'read' : 'unread']);
    assertSuccess(restoreMark, 'mail mark restore');

    // flag
    const setFlag = olk(['mail', 'flag', String(knownEmailId), '--status', 'flagged']);
    assertSuccess(setFlag, 'mail flag --status flagged');
    const restoreFlag = olk(['mail', 'flag', String(knownEmailId), '--status', wasFlag === 1 ? 'flagged' : wasFlag === 2 ? 'completed' : 'none']);
    assertSuccess(restoreFlag, 'mail flag restore');

    // categories — clear is universally safe; --set requires a category that
    // already exists in Outlook, which the upstream AppleScript can't create.
    const clearCats = olk(['mail', 'categories', String(knownEmailId), '--clear']);
    assertSuccess(clearCats, 'mail categories --clear');
    if (wasCats.length > 0) {
        const restoreCats = olk(['mail', 'categories', String(knownEmailId), '--set', wasCats.join(',')]);
        assertSuccess(restoreCats, 'mail categories restore (--set previous)');
    }
    else {
        // Idempotent re-clear is the cleanest "leave no trace" restore.
        const reClear = olk(['mail', 'categories', String(knownEmailId), '--clear']);
        assertSuccess(reClear, 'mail categories restore (re-clear)');
    }
}
else {
    console.log('  SKIP  mark/flag/categories (no email id available)');
}

// ---------------------------------------------------------------------------
// 7. Destructive prepare paths (don't confirm) — sandboxed via OLK_HOME
// ---------------------------------------------------------------------------
section('Destructive prepare flows (no confirm)');
if (knownEmailId != null) {
    const trash = olk(['mail', 'prepare-delete', String(knownEmailId)]);
    assertSuccess(trash, 'mail prepare-delete');
    check('prepare-delete returns token_id', typeof trash.parsed?.data?.token_id === 'string');
    check('prepare-delete returns expires_at', typeof trash.parsed?.data?.expires_at === 'string');

    const archive = olk(['mail', 'prepare-archive', String(knownEmailId)]);
    assertSuccess(archive, 'mail prepare-archive');

    const junk = olk(['mail', 'prepare-junk', String(knownEmailId)]);
    assertSuccess(junk, 'mail prepare-junk');

    // Move to "Deleted Items" folder id (5 was visible in folder listing earlier).
    // We don't confirm — token is harmless after expiry.
    const moveDest = 5;
    const move = olk(['mail', 'prepare-move', String(knownEmailId), String(moveDest)]);
    assertSuccess(move, 'mail prepare-move');

    const batchDel = olk(['mail', 'prepare-batch-delete'], { input: `${knownEmailId}\n` });
    assertSuccess(batchDel, 'mail prepare-batch-delete (1 id via stdin)');

    const batchMove = olk(['mail', 'prepare-batch-move', String(moveDest)], { input: `${knownEmailId}\n` });
    assertSuccess(batchMove, 'mail prepare-batch-move (1 id via stdin)');

    // Negative: confirm with a bogus token must error.
    const badConfirm = olk(['mail', 'confirm-delete', '00000000-0000-0000-0000-000000000000', String(knownEmailId)]);
    check('confirm-delete with unknown token errors',
        badConfirm.exitCode !== 0 && badConfirm.parsed?.ok === false);
}
else {
    console.log('  SKIP  prepare flows (no email id available)');
}

// ---------------------------------------------------------------------------
// 8. Calendar
// ---------------------------------------------------------------------------
section('Calendar');
let knownEventId = null;
{
    const cals = olk(['cal', 'calendars']);
    assertSuccess(cals, 'cal calendars');

    const list = olk(['cal', 'list', '--days', '90', '--limit', '5']);
    assertSuccess(list, 'cal list --days 90 --limit 5');
    knownEventId = list.parsed?.data?.items?.[0]?.id ?? null;

    const ranged = olk(['cal', 'list', '--start', '2020-01-01T00:00:00Z', '--end', '2030-12-31T00:00:00Z', '--limit', '3']);
    assertSuccess(ranged, 'cal list --start/--end');

    if (knownEventId != null) {
        const got = olk(['cal', 'get', String(knownEventId)]);
        assertSuccess(got, `cal get ${knownEventId}`);
        check('cal get returns attendees array', Array.isArray(got.parsed?.data?.attendees));
    }
    else {
        console.log('  SKIP  cal get (no events in 90 days)');
    }

    const search = olk(['cal', 'search', 'meeting', '--limit', '2']);
    assertSuccess(search, 'cal search "meeting"');
}

// ---------------------------------------------------------------------------
// 9. Contacts / tasks / notes
// ---------------------------------------------------------------------------
section('Contacts / tasks / notes');
{
    const cl = olk(['contacts', 'list', '--limit', '3']);
    assertSuccess(cl, 'contacts list');
    const cs = olk(['contacts', 'search', 'a', '--limit', '3']);
    assertSuccess(cs, 'contacts search');

    const tl = olk(['tasks', 'list', '--limit', '3']);
    assertSuccess(tl, 'tasks list');
    const tlOpen = olk(['tasks', 'list', '--limit', '3', '--incomplete']);
    assertSuccess(tlOpen, 'tasks list --incomplete');
    const ts = olk(['tasks', 'search', 'a', '--limit', '3']);
    assertSuccess(ts, 'tasks search');

    const nl = olk(['notes', 'list', '--limit', '3']);
    assertSuccess(nl, 'notes list');
    const ns = olk(['notes', 'search', 'a', '--limit', '3']);
    assertSuccess(ns, 'notes search');
}

// ---------------------------------------------------------------------------
// 10. Folder lifecycle round-trip (create → rename → prepare-delete → confirm-delete)
// ---------------------------------------------------------------------------
section('Folder lifecycle (self-cleaning round-trip)');
{
    // Use a random suffix so re-running the harness can't collide with itself.
    const suffix = Math.floor(Math.random() * 1e6).toString(36);
    const initialName = `olk-verify-${suffix}`;
    const renamedName = `${initialName}-renamed`;

    const create = olk(['folder', 'create', '--name', initialName]);
    assertSuccess(create, `folder create ${initialName}`);
    const folderId = create.parsed?.data?.folder?.id;
    check('folder create returns numeric id', typeof folderId === 'number');

    if (typeof folderId === 'number') {
        const rename = olk(['folder', 'rename', String(folderId), renamedName]);
        assertSuccess(rename, 'folder rename');

        // For the destructive path we share the manager's disk store (sandbox)
        // so prepare→confirm round-trips work across spawnSync invocations.
        const prep = olk(['folder', 'prepare-delete', String(folderId)]);
        assertSuccess(prep, 'folder prepare-delete');
        const tokenId = prep.parsed?.data?.token_id;
        check('folder prepare-delete returns token_id', typeof tokenId === 'string');

        if (typeof tokenId === 'string') {
            const conf = olk(['folder', 'confirm-delete', tokenId, String(folderId)]);
            assertSuccess(conf, 'folder confirm-delete');
        }
    }
}

// ---------------------------------------------------------------------------
// Tally
// ---------------------------------------------------------------------------
console.log(`\n=== Result: ${pass} passed, ${fail} failed ===`);
if (fail > 0) {
    console.log('Failures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
}
process.exit(0);
