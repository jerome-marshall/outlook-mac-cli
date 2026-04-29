# PRD: `olk` — Outlook for Mac CLI for AI Agents

> **Status:** Draft, 2026-04-29
> **Author:** Jerome Marshall
> **Upstream:** Ports the AppleScript backend from `[hasan-imam/mcp-outlook-applescript](https://github.com/hasan-imam/mcp-outlook-applescript)` (MIT) into a standalone CLI. Attribution preserved in `NOTICE`.

## Problem Statement

Jerome wants AI agents (Cursor, Claude Code, scripts) to operate on his work mail and calendar from the terminal — read inbox, search messages, list and create calendar events, draft outbound mail, manage folders. The Microsoft Graph path is blocked at Nutanix (admin consent required for Graph CLI tools, app-registration creation returns 403 for regular users), so Graph-based CLIs like `m365` and `Microsoft.Graph.Authentication` are not viable without an IT ticket.

Local Outlook for Mac is signed in and synced. AppleScript can already see mail folders, calendar events, contacts, and tasks. The most complete known automation surface for this — `hasan-imam/mcp-outlook-applescript` — exists as an MCP server only. Jerome doesn't want MCP for this workflow; he wants a normal CLI binary that any agent or shell script can call.

A traditional non-MCP AppleScript Outlook CLI does not exist on the public market. The only ready-made standalone CLI (`outlook365-cli`) intercepts OWA browser tokens and uses undocumented endpoints — unacceptable risk for a corporate account.

## Solution

A single-binary CLI named `olk` that exposes every operation from the upstream MCP server as a subcommand. Same AppleScript backend, same delimiter-based output protocol, same approval flow for destructive operations — but driven from argv, returning stable JSON envelopes that agents can pipe through `jq`, with no MCP server, no network, no OAuth, and no IT involvement.

The CLI is JSON-first by default (`--json` is the default output format) and provides `--table` for human use. Every command supports `--help` with examples. Destructive operations use a two-step `prepare`/`confirm` flow whose tokens are persisted to disk so an agent can prepare in one invocation and confirm in another.

## User Stories

### Discovery & onboarding

1. As a new user, I want `olk --help` to list every subcommand grouped by category (mail, calendar, contacts, tasks, notes, folders), so that I can discover the surface without reading docs.
2. As a new user, I want `olk doctor` to verify Outlook is installed, running, has Automation permission granted, and Node ≥ 20, so that I get a single actionable diagnostic before my first real command.
3. As a new user, I want `olk version` to print the CLI version and the upstream MCP version it was ported from, so that I can report bugs accurately.
4. As an agent author, I want every command to support `--help` with at least one runnable example, so that I can learn each command without reading the source.

### Mail — read

1. As an agent, I want `olk mail folders` to list every mail folder with id, name, parent id, account id, message count, and unread count, so that I can target operations by folder id.
2. As an agent, I want `olk mail list --folder Inbox --limit 10` to return the most recent N messages with metadata only (no body), so that I can survey a folder cheaply.
3. As an agent, I want `olk mail list` to default to the user's primary inbox when no `--folder` is given, so that the common case is a one-flag command.
4. As an agent, I want `olk mail unread --folder Inbox` to list only unread mail in a folder, so that I can build "what's new" workflows.
5. As an agent, I want `olk mail unread-count` (and `--folder` variant) to return a single integer, so that I can quickly check inbox state.
6. As an agent, I want `olk mail read <id>` to return the full message including plain-text body, attachments list, and headers, so that I can answer "what does this email say".
7. As an agent, I want `olk mail search "<query>"` and `olk mail search --folder <id> "<query>"` to return matching messages with pagination, so that I can find things by subject or sender.
8. As an agent, I want every list/search command to return `{ items, count, hasMore }` and accept `--limit` and `--offset`, so that pagination is uniform across the CLI.
9. As an agent, I want list/search commands to accept `--after <ISO-date>` and `--before <ISO-date>`, so that I can narrow results by time window.

### Mail — attachments

1. As an agent, I want `olk mail attachments <email-id>` to list attachments with id, name, size, MIME type, and inline flag, so that I can decide what to download.
2. As an agent, I want `olk mail attachment-download <email-id> <attachment-id> --out <path>` to save an attachment to disk, so that I can process its contents.

### Mail — outbound

1. As an agent, I want `olk mail send --to a@x.com --subject "..." --body-file body.md` to send mail using the local Outlook account, so that I can compose without needing SMTP.
2. As an agent, I want `olk mail send` to support `--cc`, `--bcc`, `--reply-to`, `--attach <path>` (repeatable), and `--inline-image cid=<path>` (repeatable), so that I can produce rich messages.
3. As an agent, I want `olk mail send` to default to creating a draft and require `--send` to actually transmit, so that mistakes don't ship.
4. As an agent, I want `olk mail send` to read body from `--body-file -` (stdin), so that newline-heavy bodies don't have to be argv-escaped.

### Mail — organization

1. As an agent, I want `olk mail mark <email-id> read|unread`, so that I can control read state.
2. As an agent, I want `olk mail flag <email-id> --status none|flagged|completed`, so that I can manage flags.
3. As an agent, I want `olk mail categories <email-id> --set "Work,Important"` (and `--clear`), so that I can tag messages.
4. As an agent, I want destructive operations (`delete`, `move`, `archive`, `junk`) to be split into `prepare` and `confirm` subcommands, so that I always see a preview and an explicit token before the change.
5. As an agent, I want `olk mail prepare-delete <email-id>` to print a preview and a one-time token (TTL 5 min) and `olk mail confirm-delete <token>` to execute, so that I cannot accidentally delete in a single step.
6. As an agent, I want the same `prepare`/`confirm` shape for `move`, `archive`, and `junk`, so that the destructive surface has one mental model.
7. As an agent, I want batch versions (`prepare-batch-delete`, `prepare-batch-move`, etc.) that take a list of ids on stdin, so that I can operate on many messages without invoking the CLI per message.
8. As an agent, I want approval tokens to persist to `~/.olk/approvals/`, so that the prepare and confirm steps can run in separate `olk` invocations.
9. As an agent, I want the `confirm` step to verify a content hash of the target before executing, so that I never delete a message that changed between prepare and confirm.

### Folders

1. As an agent, I want `olk folder create --name X --parent <id?>`, `olk folder rename <id> <new>`, `olk folder move <id> <new-parent-id>`, so that I can shape the mailbox.
2. As an agent, I want `olk folder prepare-delete <id>` / `confirm-delete <token>` and the same for `empty`, so that destructive folder ops follow the same approval shape.

### Calendar

1. As an agent, I want `olk cal calendars` to list calendars/folders, so that I know which calendar an event belongs to.
2. As an agent, I want `olk cal list --days 7` and `olk cal list --start <ISO> --end <ISO>` to list events, so that I can answer "what's on my schedule".
3. As an agent, I want `olk cal list --calendar <id>` to scope by calendar, so that I can ignore noisy shared calendars.
4. As an agent, I want `olk cal get <event-id>` to return full event details including attendees, location, recurrence info, body, so that I can summarize a meeting.
5. As an agent, I want `olk cal search "<query>"` with `--after`/`--before`, so that I can find events by title.
6. As an agent, I want `olk cal create --subject "..." --start <ISO> --end <ISO> --attendees a@x.com,b@y.com --location "..." --body-file body.md`, so that I can schedule events.
7. As an agent, I want `olk cal create` to support `--recur "FREQ=WEEKLY;BYDAY=MO,WE;COUNT=10"`-style options, so that I can create recurring events.
8. As an agent, I want `olk cal update <id> --field=value...`, so that I can adjust event details.
9. As an agent, I want `olk cal delete <id>` and `olk cal respond <id> --status accepted|tentative|declined --apply-to single|series`, so that I can manage invitations.

### Contacts, tasks, notes

1. As an agent, I want `olk contacts list`, `olk contacts search <q>`, `olk contacts get <id>`, so that I can look up people.
2. As an agent, I want `olk tasks list`, `olk tasks list --incomplete`, `olk tasks search <q>`, `olk tasks get <id>`, so that I can inspect to-dos.
3. As an agent, I want `olk notes list`, `olk notes search <q>`, `olk notes get <id>`, so that I can read OneNote-style notes from the terminal.

### Accounts

1. As an agent, I want `olk accounts list` to enumerate Outlook accounts and mark the default, so that I can disambiguate folders/events that belong to multiple accounts.

### Output, errors, and machine-readability

1. As an agent, I want every command to default to compact JSON on stdout and human-readable errors on stderr, so that pipes don't break on diagnostic noise.
2. As an agent, I want `--json` (default), `--table`, and `--ndjson` (for streaming list results), so that I can choose the right shape for the consumer.
3. As an agent, I want every error to be printed on stderr as `{ ok: false, error: { code, message } }` with a non-zero exit code, so that I can branch on `code` programmatically.
4. As an agent, I want a stable list of error codes (`OUTLOOK_NOT_RUNNING`, `APPLESCRIPT_PERMISSION_DENIED`, `APPLESCRIPT_TIMEOUT`, `NOT_FOUND`, `VALIDATION_ERROR`, `APPROVAL_TOKEN_INVALID`, `APPROVAL_TOKEN_EXPIRED`, `APPROVAL_HASH_MISMATCH`, `ATTACHMENT_NOT_FOUND`, `MAIL_SEND_ERROR`, `APPLESCRIPT_ERROR`), so that error handling is exhaustive.
5. As a human, I want `--table` output to render a column-aligned summary of list results, so that I can read folder listings without `jq`.
6. As an agent, I want successful list outputs to always envelope as `{ ok: true, data: { items, count, hasMore } }` and successful single-resource outputs as `{ ok: true, data: <resource> }`, so that the parser shape is predictable.

### Configuration

1. As a user, I want `olk config get` and `olk config set <key> <value>` to manage `~/.olk/config.json`, so that I can persist defaults like default folder or default output format.
2. As a user, I want `OLK_OUTLOOK_TIMEOUT_MS`, `OLK_APPROVAL_TTL_MS`, and `OLK_NO_COLOR` environment overrides, so that I can tune behavior without editing config.

### Safety

1. As a user, I want destructive-by-default commands disabled unless I pass `--allow-destructive` or use the `prepare`/`confirm` flow, so that the CLI is safe in agent hands.
2. As a user, I want `olk` to refuse to run any operation if Outlook is not running and to print exactly which permission to grant in System Settings if Automation is denied, so that setup is self-explanatory.

### Distribution

1. As a user, I want to install via `npm install -g outlook-mac-cli` once published, so that the install is one command.
2. As a user, I want a working `npm pack && npm install -g ./outlook-mac-cli-*.tgz` flow before publication, so that I can dogfood without a registry.
3. As an integrator, I want `olk` to be a single Node bin with no native dependencies, so that the binary is portable across Mac dev machines.

## Implementation Decisions

### Architectural

- **Port, don't rewrite.** The MCP repo's AppleScript layer (`executor`, `scripts`, `parser`, `repository`, `account-repository`, `calendar-writer`, `calendar-manager`, `content-readers`, `mail-sender`), the approval system, the parsers, the domain tool classes, and the utility/error modules are all MCP-agnostic and fully reusable. Only `src/index.ts` is MCP-specific and gets replaced by a `commander`-based CLI entrypoint.
- **Dependency surface stays minimal.** `commander` for argv parsing, `zod` for argument validation (matches upstream tool schemas), and the upstream's existing dependencies. No MCP SDK, no native deps, no DB.
- **TypeScript strict mode**, `ES2022`, `NodeNext` modules, matching upstream conventions exactly.
- **Lazy backend init.** The AppleScript backend is initialized on first use within a process — same as upstream — so command-not-found and `--help` paths don't touch Outlook.
- **Stable JSON envelope** is the contract with agents. Changing the shape of `data` is a breaking change.

### Modules to build

- `applescript/` — ported verbatim from upstream (executor, scripts, parser, repository, account-repository, calendar-writer, calendar-manager, content-readers, mail-sender, index).
- `approval/` — ported verbatim, plus a new `disk-store` adapter behind the existing `ApprovalTokenManager` interface so tokens persist across CLI invocations.
- `tools/` — ported verbatim from `src/tools/` (mail, calendar, contacts, tasks, notes, mailbox-organization). These remain the only place that touches `IRepository`.
- `cli/` — new module:
  - `cli/index.ts` — bin entrypoint, sets up `commander`, wires output formatter, dispatches errors.
  - `cli/commands/<group>.ts` — one file per command group (`mail`, `cal`, `contacts`, `tasks`, `notes`, `folder`, `accounts`, `config`, `doctor`).
  - `cli/output.ts` — JSON, NDJSON, and table formatters; envelope construction.
  - `cli/approval-runtime.ts` — disk-backed approval store at `~/.olk/approvals/`, plus a thin in-process fallback when an env var requests it.
  - `cli/config.ts` — read/write `~/.olk/config.json`.
  - `cli/argv.ts` — shared option types: `--limit`, `--offset`, `--after`, `--before`, `--json`/`--table`/`--ndjson`, `--folder`, file/stdin readers for body-like inputs.
- `utils/dates.ts`, `utils/errors.ts` — ported verbatim. `OutlookMcpError` renamed to `OlkError`; `ErrorCode` enum extended with the approval-on-disk codes.
- `database/repository.ts` — `IRepository` and `IWriteableRepository` interfaces, ported verbatim.

### CLI vs MCP semantic differences

- **Approval persistence.** MCP runs as one process; tokens live in memory. CLI runs per-invocation; tokens **must** be persisted to disk. The token store interface stays the same; the implementation gains a disk backend.
- **Output contract.** Replaces MCP `{ text, isError }` content blocks with stdout-JSON / stderr-error envelopes. List/search results use `{ items, count, hasMore }` inside `data` to match upstream's pagination shape.
- **No tool descriptions as discovery.** `commander` `--help` plus a generated man page replace `server.tool(...)` descriptions. The upstream descriptions are still useful as input for `--help` text.
- **Schemas via Zod.** Each command parses argv into the same Zod strict schema upstream uses. Validation errors map to `VALIDATION_ERROR`.
- **No batch-by-tool-call concept.** Batch destructive ops (`prepare-batch-*`, `confirm-batch-*`) read ids from stdin (newline- or comma-delimited).

### Distribution

- **Package name:** `outlook-mac-cli` on npm (later — first iteration installs from a local tarball).
- **Bin name:** `olk`.
- **Engines:** Node ≥ 20.
- **OS:** `darwin` only.
- **License:** MIT, with `NOTICE` crediting the upstream MCP project; README links to the upstream and explains the porting relationship.

### Repository conventions

- Same lint/test toolchain as upstream (`vitest`, `tsc --noEmit`, build script that compiles to `dist/` and chmods the bin shebang).
- `scripts/audit.sh` ported and adjusted: drops MCP-specific checks, adds CLI-specific checks (man page exists, every command has `--help`, JSON envelope shape stays valid for a fixture run).
- `scripts/smoke.mjs` ported to drive the `olk` binary end-to-end against a live Outlook for a happy-path subset (folders, list inbox, get one message, list calendar events, prepare/confirm a no-op delete on a draft).
- Use [opensrc](https://github.com/jhmaster2000/opensrc) cache at `~/.opensrc/repos/github.com/hasan-imam/mcp-outlook-applescript/main` as the source for the port.

## Testing Decisions

### What makes a good test (project-wide)

- Tests assert **observable behavior**, not implementation details. For pure modules that means input → output. For modules with side effects (subprocess, filesystem) we assert the **commands issued** or the **files written**, not the internal call sequence.
- Tests must run without Outlook present. The only Outlook-dependent tests are the opt-in smoke suite gated on `OLK_LIVE=1`.
- No mocking of `osascript` itself — instead, swap `IRepository` with an in-memory fake when testing layers above it.

### Modules with unit tests in v1

- `**applescript/scripts`** — for every script-builder, snapshot-test the generated AppleScript string and assert all string interpolations come from `escapeForAppleScript`. Prior art: upstream `test/unit.test.ts` does this exhaustively.
- `**applescript/parser`** — fixture-based: feed delimited AppleScript outputs (`{{RECORD}}`, `{{FIELD}}`, `{{=}}`, `{{NULL}}`) and assert typed row outputs. Prior art: upstream parser tests.
- `**applescript/executor**` — `escapeForAppleScript` covers all dangerous chars (backslash, quote, CR, LF, CRLF). `categorizeError` matches the upstream regex set.
- `**tools/**` (mail, calendar, contacts, tasks, notes, mailbox-organization) — tested against an in-memory `IRepository` mock. Cover pagination envelopes, date conversions, error mapping. Prior art: upstream tool tests.
- `**approval/**` — token TTL, single-use semantics, hash mismatch detection, GC at 100 entries. Prior art: upstream approval tests.
- `**cli/output**` — JSON envelope shape stability for success and error cases; NDJSON streaming yields one line per item; `--table` renders without throwing on null fields.
- `**cli/approval-runtime**` — disk-persistence round-trip; tokens written by one process are readable by another; expired tokens are rejected; corrupted store is handled gracefully.
- `**cli/argv**` — body-file reader handles file path, `-` (stdin), and missing-file errors; `--limit`/`--offset` parse and validate.
- `**utils/dates**` — Apple-epoch ↔ ISO conversion is exact for known-good fixtures.
- `**utils/errors**` — every `ErrorCode` round-trips through serialization; `OlkError.toJSON()` shape is stable.

### Smoke (live) tests

Opt-in via `OLK_LIVE=1`. Requires Outlook running. Exercises a happy path: `doctor` → `mail folders` → `mail list --folder Inbox --limit 1` → `mail read <id>` → `cal list --days 1` → `mail prepare-delete <draft-id>` → `mail confirm-delete <token>` (against a self-created throwaway draft). Adapted from upstream `scripts/smoke-test.mjs`.

## Out of Scope

- **Microsoft Graph / OAuth backend.** This is the whole reason the project exists; the CLI is AppleScript-only.
- **New Outlook for Mac (the rewritten client).** AppleScript on the new Outlook is degraded; the upstream and this project both target classic Outlook for Mac. We will document the requirement, not paper over it.
- **Cross-platform support.** macOS only.
- **Windows / Linux Outlook automation.**
- **TUI / interactive shell.** `olk` is a one-shot CLI; building a curses UI is a separate project.
- **Daemon mode.** Each invocation is independent; no long-running background process.
- **Plugin architecture.** All commands ship in-tree; no third-party command extension API in v1.
- **Multi-account login orchestration.** The CLI uses whatever accounts the local Outlook app has signed in. It does not manage credentials.
- **Server / hosted variant.** Local Mac only.
- **Calendar `freebusy` against external attendees.** AppleScript can't see external availability cleanly; out of scope for v1.
- **MCP server in the same repo.** If we ever want both, that's a separate package; this repo stays a pure CLI to avoid scope drift.

## Further Notes

### Sequencing

A reasonable build order, each step landing as its own PR:

1. **Scaffold + ported foundation.** Project skeleton, ported `applescript/`, `database/`, `utils/`, ported `tools/`, ported `approval/` (still in-memory). Wire `vitest` and `tsc`. Run upstream's pure tests against the port to confirm bit-for-bit fidelity.
2. **CLI entrypoint + read-only mail.** `cli/index`, `cli/output`, `cli/argv`, the `mail` command group's read-only subset (`folders`, `list`, `unread`, `unread-count`, `read`, `search`, `attachments`, `attachment-download`). `doctor`, `version`. JSON envelope locked.
3. **Calendar read.** `cal calendars`, `cal list`, `cal get`, `cal search`. Smoke test the live happy path.
4. **Contacts, tasks, notes, accounts.** All read-only.
5. **Outbound mail + calendar writes.** `mail send` with draft-by-default, `cal create`, `cal update`, `cal delete`, `cal respond`.
6. **Mail organization (non-destructive).** `mark`, `flag`, `categories`. Folder create/rename/move.
7. **Approval-runtime + destructive ops.** Disk-backed token store, `prepare`/`confirm` for delete/move/archive/junk/empty-folder/delete-folder, including batch.
8. **Polish.** `--table` formatter, man page, `audit.sh`, `smoke.mjs`, README, NOTICE, npm publish prep.

### Open questions deferred to implementation

- Exact subcommand naming for batch destructives (`prepare-batch-delete` vs `mail batch prepare-delete`). Pick one consistent shape during step 7 and stick to it.
- Whether `--json` should default to compact or pretty when stdout is a TTY. Default to pretty on TTY, compact otherwise (mimics `gh`, `jq`).
- Whether `olk doctor` should attempt to launch Outlook if it's not running. Probably no — fail loudly with the exact `open -a "Microsoft Outlook"` command in the error message instead.

### Attribution

The AppleScript backend is a near-verbatim port from `hasan-imam/mcp-outlook-applescript` (MIT). The `NOTICE` file credits the upstream author and links to the source repo and the specific commit hash the port was made from.