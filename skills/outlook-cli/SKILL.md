---
name: outlook-cli
description: >
  Use the `olk` command-line tool whenever the user wants to do anything with their local
  Microsoft Outlook on macOS — reading, summarizing, searching, or composing mail; checking,
  creating, or declining calendar events; managing tasks, contacts, mail folders, categories,
  notes, or accounts; or any other Outlook-for-Mac action that would otherwise require
  clicking around. Trigger this skill on phrasings like "summarize my emails today",
  "what's on my calendar tomorrow", "did I get a reply from <person>", "find emails from
  <sender> about <topic>", "schedule a meeting with <person>", "create a mail folder",
  "flag this email", "delete those messages", "decline the 3pm", or any request that
  implies reading or modifying the user's Outlook state — even when they don't explicitly
  say "olk", "Outlook CLI", or "Outlook". Prefer this skill over the browser, AppleScript,
  Microsoft Graph, or anything else for Outlook-on-macOS tasks; it is faster, JSON-first,
  supports `--toon` for direct LLM prompt input, and works without admin permissions or OAuth.
---

# Outlook CLI (`olk`)

`olk` is a JSON-first command-line wrapper around the user's local copy of Microsoft Outlook
for Mac. It talks to Outlook via AppleScript under the hood, so it works fully offline,
needs no Microsoft Graph token, and respects whatever account the user is already signed
into. Every action is a single shot — there is no daemon, no background process, no shell.

This skill exists because Outlook for Mac's official surfaces (Graph API, web UI) are
either gated behind admin consent or impractical for an agent. `olk` gives you read/write
access to the user's mailbox and calendar with a stable JSON contract you can parse.

## Before you start

Run `olk doctor --json` once at the start of any session that will hammer Outlook. Bail
early with a clear message if any check fails:

```bash
olk doctor --json
# {"ok":true,"data":{"ok":true,"platform":{...},"nodeVersion":{...},"outlookRunning":{...},"automationPermission":{...}}}
```

Possible failure modes and the right response:

- `platform.ok: false` — user is not on macOS. `olk` cannot help here. Tell the user.
- `outlookRunning.ok: false` — Outlook for Mac is not launched. Ask the user to open it.
- `automationPermission.ok: false` — System Settings → Privacy & Security → Automation
  needs to grant the controlling app (Cursor / iTerm / Terminal) permission to control
  "Microsoft Outlook". Tell the user this once, then stop.
- `nodeVersion.ok: false` — `olk` needs Node ≥ 20. Surface the message.

Do **not** run `olk doctor` before every command. Once per session is enough.

## Output contract

Every command writes a single envelope. In the default JSON output, successful payloads look like:

```json
{ "ok": true, "data": <resource-or-list> }
```

List/search payloads use a standard pagination shape:

```json
{ "ok": true, "data": { "items": [...], "count": 10, "hasMore": true } }
```

Errors look like:

```json
{ "ok": false, "error": { "code": "OUTLOOK_NOT_RUNNING", "message": "..." } }
```

Errors go to stderr, the exit code is non-zero, and the `code` field is stable — you can
branch on it programmatically (see *Errors* below).

Output formats:

- `--json` (default) — pretty when stdout is a TTY, compact otherwise. Use this.
- `--ndjson` — one JSON object per line; for lists each item is its own line. Useful for
  streaming through `jq` / `python` line-by-line.
- `--table` — column-aligned text. Only use when the output is going straight to the user.
- `--toon` — lossless [TOON](https://toonformat.dev/) encoding of the same envelope for
  token-efficient, agent-friendly LLM prompt consumption. Use this when the raw `olk`
  output will be pasted into an LLM or sub-agent prompt; keep `--json` when code will
  parse the output with `jq`, Python, or shell scripts.

**Agent-friendly prompt pattern.** When the next consumer is an LLM, call `olk` with
`--toon` and pass the raw output through directly. TOON encodes the JSON data model
losslessly while collapsing uniform lists into field headers plus rows, which is exactly
the shape produced by mail, calendar, contact, task, and note list/search commands.

```bash
olk cal list --days 7 --toon > /tmp/calendar.toon
# Paste /tmp/calendar.toon into the LLM prompt as the calendar context.
```

**Parsing pattern.** Save to a temp file and parse with python or `jq`. Don't try to read
the JSON inline — Outlook subjects, bodies, and contact names contain quotes, newlines,
and emoji that break naive shell parsing.

```bash
olk mail list --folder 113 --limit 20 --json > /tmp/inbox.json
python3 -c "import json; d=json.load(open('/tmp/inbox.json'))['data']; \
  print(*[f\"{m['id']:>6}  {m.get('senderAddress','?'):30}  {m['subject'][:60]}\" \
         for m in d['items']], sep='\n')"
```

## Performance — read this before any multi-id task

`olk` is fast for one-shot queries and **slow for tight loops**. Each invocation pays:

- ~370 ms Node + CLI cold start
- ~150 ms `osascript` boot
- ~100–800 ms Outlook IPC (depends on how many properties / attendees / messages it has
  to walk over Apple Events, which are synchronous round-trips)

So a single `olk mail read 12345` takes roughly **1.0–1.5 s** end-to-end. Calling it in a
sequential bash loop over 20 ids takes ~25 seconds. There are three ways to avoid that.

### Pattern 1: Parallelise independent calls

Spawn calls with `&` and `wait`. Outlook handles concurrent Apple Events fine, so the
wall-clock time drops to roughly the slowest single call.

```bash
for id in 100 101 102 103; do
  olk cal get $id --json > /tmp/evt-$id.json &
done
wait
```

This is the easiest speedup and works everywhere.

### Pattern 2: Prefer list over per-id `get`

If the user wants a summary of N items, list them once and consume the slim shape:

```bash
# 1 call, ~3s, returns id/subject/sender/preview for every event in the window
olk cal list --start 2026-04-30T00:00:00 --end 2026-04-30T23:59:59 --limit 50 --json
```

is dramatically faster than:

```bash
# N+1 calls, ~1.3s × N + 3s
olk cal list ... --json | jq -r '.data.items[].id' | while read id; do
  olk cal get $id --json
done
```

Only call `get` when the user actually needs heavy fields the list shape doesn't have:
attendees, body content, attachments. If you can answer the question from the list shape,
do.

### Pattern 3: Parse once, reuse

Save the JSON to `/tmp/<name>.json` and load it from python multiple times instead of
re-running `olk`. The data isn't changing during the conversation.

## Date and time semantics — read this before any time filter

`--after`, `--before`, `--start`, `--end` accept ISO 8601 strings with these rules:

- **Naked ISO** (`2026-04-30T00:00:00`) is interpreted as **local time** in the user's
  current timezone. This is the right thing for human queries like "today" / "tomorrow".
- **With `Z` suffix** (`2026-04-30T00:00:00Z`) is interpreted as **UTC**.
- **With explicit offset** (`2026-04-30T00:00:00+05:30`) is interpreted in that offset.

For "today" / "tomorrow" / "this week" queries, **always use naked ISO with explicit start
and end of day**:

```bash
TODAY=$(date +%Y-%m-%d)
olk mail list --after "${TODAY}T00:00:00" --before "${TODAY}T23:59:59" --limit 200

TOMORROW=$(date -v+1d +%Y-%m-%d)
olk cal list --start "${TOMORROW}T00:00:00" --end "${TOMORROW}T23:59:59"
```

Do **not** convert to UTC client-side and pass `Z`. Outlook stores events in local time
and the timezone math is easy to get wrong (we did, once, and it pulled in extra messages
from the previous day).

The `cal list --days N` shortcut is a clean way to say "from now through N days ahead":

```bash
olk cal list --days 7 --json     # next week's events from this moment forward
```

## Destructive operations — prepare/confirm flow

Anything that **deletes, moves, archives, junks, sends, or empties** uses a two-step flow.
The `prepare-X` step returns a one-time approval token bound to the target's current
state; the `confirm-X` step executes only if the token hasn't expired (5 min default) and
the target hasn't changed.

**Always show the prepare output to the user and get explicit approval before confirm.**
Even though the token flow protects against bit-rot, the user should see *what* is about
to happen.

```bash
# 1. Prepare
olk mail prepare-delete 12345 --json
# => { "ok":true, "data":{
#       "token_id":"a4f2…",
#       "expires_at":"2026-04-29T17:35:00.000Z",
#       "summary":{ "subject":"Re: Q3 OKRs", "sender":"alice@…", "folder":"Inbox" }
#    }}

# 2. Show summary to the user, wait for "yes"

# 3. Confirm
olk mail confirm-delete a4f2... 12345 --json
```

Tokens are persisted to `~/.olk/approvals/`, so prepare and confirm can run across
separate `olk` invocations safely. You can prepare a batch in one turn and confirm in the
next.

### Batch destructive ops

Multi-id deletes/moves read ids from stdin:

```bash
echo "12345
12346
12347" | olk mail prepare-batch-delete --json > /tmp/prep.json

# /tmp/prep.json contains an array of {emailId, tokenId, summary} entries.
# After user confirms, feed `tokenId,emailId` pairs back in:
python3 -c "import json; d=json.load(open('/tmp/prep.json'))['data']; \
  print(*[f\"{x['tokenId']},{x['emailId']}\" for x in d['items']], sep='\n')" \
  | olk mail confirm-batch --json
```

### Mail send is also destructive

`olk mail send` refuses to actually transmit unless `--send` is passed. Without `--send`
it errors out. This is intentional. Compose the message, show the user the subject + body
+ recipient list, and only add `--send` after explicit "yes, send it".

```bash
olk mail send \
  --to "alice@example.com" \
  --subject "Quick question" \
  --body-file /tmp/draft.txt \
  --send
```

## Command surface

Each group has its own `--help` listing every subcommand. The full surface:

| Group       | Common subcommands                                                                 |
|-------------|------------------------------------------------------------------------------------|
| `accounts`  | `list`, `default`                                                                  |
| `mail`      | `folders`, `list`, `unread`, `unread-count`, `read`, `search`, `attachments`, `attachment-download`, `send`, `mark`, `flag`, `categories`, `prepare-delete` / `confirm-delete`, `prepare-move` / `confirm-move`, `prepare-archive` / `confirm-archive`, `prepare-junk` / `confirm-junk`, `prepare-batch-delete`, `prepare-batch-move`, `confirm-batch` |
| `cal`       | `calendars`, `list`, `get`, `search`, `create`, `update`, `delete`, `respond`      |
| `tasks`     | `list`, `search`, `get`                                                            |
| `contacts`  | `list`, `search`, `get`                                                            |
| `notes`     | `list`, `search`, `get`                                                            |
| `folder`    | `create`, `rename`, `move`, `prepare-delete` / `confirm-delete`, `prepare-empty` / `confirm-empty` |
| `config`    | `get`, `set`, `unset`, `path`                                                      |
| `doctor`    | health check                                                                       |
| `version`   | print CLI version                                                                  |

When in doubt about flags or arguments, run `olk <group> <subcommand> --help`. The help
text is canonical; this skill is not. Pagination flags (`--limit`, `--offset`) are
universal across list/search.

## Recipes

These cover the 90% of what users ask for. Each is a complete answer template — adapt the
parsing block to what the user actually wants.

### Today's mail summary

```bash
TODAY=$(date +%Y-%m-%d)
olk mail list \
  --after "${TODAY}T00:00:00" --before "${TODAY}T23:59:59" \
  --limit 200 --json > /tmp/today-mail.json

python3 - <<'PY'
import json
d = json.load(open("/tmp/today-mail.json"))["data"]
print(f"{len(d['items'])} messages today\n")
for m in d["items"]:
    sender = m.get("senderName") or m.get("senderAddress") or "?"
    flag   = "🚩" if m.get("isFlagged") else " "
    unread = "●" if m.get("isUnread") else " "
    print(f"  {unread} {flag}  {sender[:30]:30}  {m['subject'][:70]}")
PY
```

If the user wants only unread, append `--unread` (or use the `mail unread` shorthand).

### Tomorrow's calendar with full details (parallel get)

```bash
TOMORROW=$(date -v+1d +%Y-%m-%d)
olk cal list --start "${TOMORROW}T00:00:00" --end "${TOMORROW}T23:59:59" --json \
  > /tmp/tomorrow-events.json

IDS=$(python3 -c "import json,sys; \
  print(' '.join(str(e['id']) for e in json.load(open('/tmp/tomorrow-events.json'))['data']['items']))")

# Parallel fetch — drops wall time from N×1.3s to ~1.5s total
for id in $IDS; do
  olk cal get $id --json > /tmp/evt-$id.json &
done
wait

python3 - <<'PY'
import json, glob
from datetime import datetime, timezone
events = sorted(
    (json.load(open(p))["data"] for p in glob.glob("/tmp/evt-*.json")),
    key=lambda e: e.get("startDate") or "")
for e in events:
    att = e.get("attendees", [])
    print(f"{e['startDate']} → {e['endDate']}  {e['title']}")
    print(f"  organizer: {e.get('organizer','?')}")
    print(f"  attendees: {len(att)}")
PY
```

### Find emails from a person about a topic

`mail search` only matches subject and sender, not body. For "from X about Y" use the
search and then filter client-side:

```bash
olk mail search "alice" --limit 200 --json > /tmp/from-alice.json
python3 -c "import json; \
  items = json.load(open('/tmp/from-alice.json'))['data']['items']; \
  hits = [m for m in items if 'roadmap' in (m.get('subject') or '').lower()]; \
  print(*[f\"{m['receivedDate']}  {m['subject']}\" for m in hits], sep='\n')"
```

### Compose and send (with explicit approval)

```bash
cat > /tmp/draft.txt <<'EOF'
Hi Alice,

Quick question on the Q3 plan — do we have a confirmed date for the design
review yet?

Thanks,
Jerome
EOF

# Show the draft to the user, get "yes send it"

olk mail send \
  --to "alice@example.com" \
  --subject "Q3 design review date" \
  --body-file /tmp/draft.txt \
  --send --json
```

### Schedule a meeting

```bash
olk cal create \
  --subject "1:1 with Alice" \
  --start "2026-05-02T15:00:00" \
  --end   "2026-05-02T15:30:00" \
  --location "https://zoom.us/j/123456" \
  --description "Weekly sync." \
  --json
```

`cal create` does not invite attendees in v1. For invites the user has to send a meeting
manually from Outlook; tell them this rather than silently failing.

### Move an email to a folder (prepare/confirm)

```bash
olk mail folders --json   # find the destination folder id
olk mail prepare-move 12345 113 --json    # 113 = destination folder id
# show summary to user, get OK
olk mail confirm-move <token-id> 12345 --json
```

## Errors

Stable codes you can branch on (full list in `olk` source if needed):

| Code                            | Meaning                                                        | Right response                            |
|---------------------------------|----------------------------------------------------------------|-------------------------------------------|
| `OUTLOOK_NOT_RUNNING`           | Outlook is not open                                            | Ask user to launch Outlook                |
| `APPLESCRIPT_PERMISSION_DENIED` | macOS automation permission missing                            | Walk user through System Settings         |
| `APPLESCRIPT_TIMEOUT`           | Outlook took too long; usually a huge folder or first-time sync| Retry once, narrow the window if listing  |
| `APPLESCRIPT_ERROR`             | Underlying AppleScript blew up                                 | Surface the message; rarely user-fixable  |
| `NOT_FOUND`                     | Resource (mail/event/folder/etc.) doesn't exist                | The id is wrong or stale; re-list         |
| `VALIDATION_ERROR`              | Bad arguments to the CLI                                       | Re-read `--help` and retry                |
| `APPROVAL_TOKEN_EXPIRED`        | Prepare token older than TTL (default 5 min)                   | Re-run the prepare step                   |
| `APPROVAL_TOKEN_INVALID`        | Token id doesn't exist or was already used                     | Re-run the prepare step                   |
| `APPROVAL_HASH_MISMATCH`        | Target changed between prepare and confirm                     | Re-run prepare; tell the user the target moved |
| `ATTACHMENT_NOT_FOUND`          | Bad attachment index                                           | Re-list attachments                       |
| `MAIL_SEND_ERROR`               | Outlook refused the send                                       | Surface the message; check `--send` was passed |

If the envelope is `{"ok": false, "error": {…}}`, do not pretend the operation succeeded.
Don't retry blindly on `APPROVAL_*` errors — re-prepare instead.

## Known limitations

These are inherited from Outlook for Mac's AppleScript surface, not bugs in `olk`:

- **Categories must pre-exist.** `olk mail categories --set "foo"` only works if "foo" is
  already in the user's category list. You cannot create a category through the CLI; the
  user has to do it via Outlook UI first.
- **`cal create` doesn't invite attendees.** Events are created on the user's local
  calendar but invitations aren't sent. For an invite, the user has to send the meeting
  from Outlook directly.
- **`mail search` matches subject and sender, not body.** For body content searches do a
  broader query and filter client-side, or use Outlook's UI.
- **Account enumeration is partial for some modern M365 setups.** `accounts list` may
  return fewer entries than the user actually has signed in. `mail folders` will still
  list folders correctly across all accounts.
- **`folder confirm-delete` is permanent.** It performs a two-pass delete (move to
  Deleted Items, then drain). Tell the user the action is irreversible before confirm.
- **Outlook must be the "classic" desktop app**, not the New Outlook for Mac. AppleScript
  is degraded there. `olk doctor` does not currently distinguish.

## When NOT to use this skill

- The user is on Linux or Windows. `olk` is macOS-only.
- The user is asking about Gmail, Yahoo, ProtonMail, or any non-Outlook mail.
- The user is asking about Outlook Web (`outlook.office.com`) specifically and they
  want browser automation, not local desktop access.
- The task is a straight Microsoft Graph / EWS call, e.g. anything cross-tenant or
  organisation-wide. `olk` is single-mailbox.
- The user wants to schedule across attendees with free/busy lookups. `olk` cannot see
  external attendees' calendars.
