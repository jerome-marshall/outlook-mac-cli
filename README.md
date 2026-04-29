# `olk` — Outlook for Mac CLI

A single-binary command-line interface for Microsoft Outlook on Mac. Read your inbox, search mail, list calendar events, send mail, and manage folders from the terminal — all backed by AppleScript, JSON-first, with a stable error envelope agents can branch on.

No Microsoft Graph. No OAuth. No IT ticket. If Outlook is signed in on your Mac, `olk` works.

## Installation

`olk` is not yet published to npm. To install it locally:

```bash
git clone <this-repo>
cd outlook-mac-cli
npm install
npm run build
npm link    # exposes `olk` on your PATH
```

Verify the install:

```bash
olk doctor
olk version
```

`doctor` checks that you're on macOS, on Node ≥ 20, that Outlook is running, and that automation permission is granted.

## Quickstart

```bash
olk accounts list
olk mail folders
olk mail unread-count --folder 113
olk mail list --folder 113 --limit 10 --table
olk mail read 12345
olk cal list --days 7 --table
```

Every command supports `--help` with usage examples.

## Agent skill

This repository includes a bundled Cursor/Claude skill at [`skills/outlook-cli/SKILL.md`](./skills/outlook-cli/SKILL.md). Install or copy that skill into your agent skills directory when you want agents to use `olk` directly for Outlook workflows.

The skill documents the safe `olk doctor --json` startup check, read/write command recipes, destructive-operation approval flow, and when agents should prefer `--toon` for prompt-ready context versus `--json` for code parsing.

## Output contract

By default `olk` prints compact JSON on stdout and JSON errors on stderr. Four formats are available:

- `--json` (default) — pretty when stdout is a TTY, compact otherwise
- `--ndjson` — one JSON object per line; for list results, each item is its own line
- `--table` — column-aligned text for human reading
- `--toon` — lossless [TOON](https://toonformat.dev/) for token-efficient, agent-friendly LLM prompt consumption

Successful payloads always envelope as:

```json
{ "ok": true, "data": <resource> }
```

List/search payloads use the standard pagination shape:

```json
{ "ok": true, "data": { "items": [...], "count": 10, "hasMore": true } }
```

Errors always envelope as:

```json
{ "ok": false, "error": { "code": "OUTLOOK_NOT_RUNNING", "message": "..." } }
```

A non-zero exit code accompanies every error envelope.

Use `--json` when the output will be parsed in code (`jq`, Python's built-in `json`, shell scripts). Use `--toon` when the raw output will be fed verbatim into an LLM or sub-agent prompt, where repeated JSON keys are expensive tokens. Both formats describe the same `{ ok, data }` shape; errors are always JSON regardless of the requested format.

For agent workflows, `--toon` lets the CLI produce prompt-ready context directly:

```bash
olk cal list --days 7 --toon > /tmp/calendar.toon
# Paste /tmp/calendar.toon into the next LLM prompt as calendar context.
```

## Destructive operations

Anything that deletes, moves, archives, or junks mail uses a two-step `prepare`/`confirm` flow. The prepare step returns a one-time approval token; the confirm step executes the action only if the target hasn't changed and the token hasn't expired.

```bash
olk mail prepare-delete 12345
# => { "ok": true, "data": { "token_id": "...", "expires_at": "...", ... } }

olk mail confirm-delete <token-id> 12345
# => { "ok": true, "data": { "success": true, "message": "Email moved to Deleted Items." } }
```

Tokens are persisted to `~/.olk/approvals/`, so prepare and confirm can run in separate `olk` invocations.

Batch destructive operations read ids from stdin:

```bash
echo "12345,12346,12347" | olk mail prepare-batch-delete
```

## Configuration

`olk` reads `~/.olk/config.json`. Use the built-in subcommand:

```bash
olk config set defaultOutput table
olk config set defaultOutput toon
olk config set defaultFolder 113
olk config get
```

Environment overrides:

- `OLK_HOME` — override the config + approvals directory (default: `~/.olk`)
- `OLK_APPROVAL_TTL_MS` — override approval token TTL (default: 5 minutes)
- `OLK_TOKENS_IN_MEMORY=1` — skip the disk-backed token store (single-process tests)
- `OLK_NO_COLOR=1` — disable ANSI colors

## Running the tests

```bash
npm test
```

The unit suite runs without Outlook present (it tests AppleScript generation, parsers, the approval system, the disk store, and the CLI output formatter).

The opt-in live smoke test exercises the binary end-to-end against your real mailbox:

```bash
OLK_LIVE=1 npm run build && OLK_LIVE=1 node scripts/smoke.mjs
```

## How this relates to `mcp-outlook-applescript`

This CLI is a near-verbatim port of [`hasan-imam/mcp-outlook-applescript`](https://github.com/hasan-imam/mcp-outlook-applescript). The AppleScript backend, parsers, repository abstractions, approval system, and domain tool classes are reused as-is. Only the MCP server entrypoint is replaced with a `commander`-based CLI, and the in-memory approval store is swapped for a disk-backed one so prepare/confirm can run across separate processes.

Full attribution lives in [`NOTICE`](./NOTICE).

## Out of scope (v1)

- Microsoft Graph / OAuth (the entire reason this CLI exists)
- New Outlook for Mac (AppleScript is degraded there; we target classic Outlook)
- Cross-platform support (macOS only)
- TUI / interactive shell (single-shot CLI by design)
- Daemon mode (each invocation is independent)
- Calendar `freebusy` against external attendees (AppleScript can't see this cleanly)

## License

MIT. See [`LICENSE`](./LICENSE) and [`NOTICE`](./NOTICE) for upstream attribution.
