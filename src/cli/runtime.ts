/**
 * Lazy-initialized runtime for the olk CLI.
 *
 * The MCP upstream wires the AppleScript backend in `createServer` and
 * shares it across every tool call within a long-running process. The CLI is
 * one-shot: each invocation builds the runtime, runs one command, exits.
 *
 * The runtime is intentionally identical in shape to the upstream
 * `createServer` initialization — same factories, same dependency graph —
 * so the upstream tools can be reused without modification.
 *
 * Initialization happens on first `runtime.tools()` access; commands like
 * `--help`, `version`, and `doctor` never construct the backend, so they work
 * even when Outlook isn't running.
 */

import {
    createAppleScriptRepository,
    createAppleScriptContentReaders,
    createAccountRepository,
    createCalendarWriter,
    createCalendarManager,
    createMailSender,
    isOutlookRunning,
    type IAccountRepository,
    type AppleScriptContentReaders,
    type ICalendarWriter,
    type ICalendarManager,
    type IMailSender,
} from '../applescript/index.js';
import { createMailTools, type MailTools } from '../tools/mail.js';
import { createCalendarTools, type CalendarTools } from '../tools/calendar.js';
import { createContactsTools, type ContactsTools } from '../tools/contacts.js';
import { createTasksTools, type TasksTools } from '../tools/tasks.js';
import { createNotesTools, type NotesTools } from '../tools/notes.js';
import { createMailboxOrganizationTools, type MailboxOrganizationTools } from '../tools/mailbox-organization.js';
import { ApprovalTokenManager, InMemoryTokenStore, type ITokenStore } from '../approval/index.js';
import { OutlookNotRunningError } from '../utils/errors.js';

import { DiskTokenStore } from './approval-runtime.js';

/** Bundle of lazily-instantiated upstream tools. */
export interface RuntimeTools {
    readonly accountRepository: IAccountRepository;
    readonly mail: MailTools;
    readonly calendar: CalendarTools;
    readonly contacts: ContactsTools;
    readonly tasks: TasksTools;
    readonly notes: NotesTools;
    readonly org: MailboxOrganizationTools;
    readonly calendarWriter: ICalendarWriter;
    readonly calendarManager: ICalendarManager;
    readonly mailSender: IMailSender;
    readonly tokenManager: ApprovalTokenManager;
}

/** Options for constructing the runtime. */
export interface RuntimeOptions {
    /** Override the approval token store (e.g., in-memory for tests). */
    readonly tokenStore?: ITokenStore;
    /** Override the token TTL in milliseconds. */
    readonly tokenTtlMs?: number;
}

/** Default approval TTL (5 minutes), overridable via env or constructor option. */
const DEFAULT_APPROVAL_TTL_MS = 5 * 60 * 1000;

function resolveApprovalTtlMs(): number {
    const raw = process.env['OLK_APPROVAL_TTL_MS'];
    if (raw == null || raw.length === 0) return DEFAULT_APPROVAL_TTL_MS;
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_APPROVAL_TTL_MS;
    return n;
}

function defaultTokenStore(): ITokenStore {
    const inMemory = process.env['OLK_TOKENS_IN_MEMORY'];
    if (inMemory === '1' || inMemory === 'true') {
        return new InMemoryTokenStore();
    }
    return new DiskTokenStore();
}

/**
 * Lazy CLI runtime. Mirrors the dependency graph used by the MCP server but
 * without the MCP transport. Calls to `tools()` first verify Outlook is
 * running, then instantiate every upstream tool exactly once.
 */
export class Runtime {
    private readonly tokenManager: ApprovalTokenManager;
    private cached: RuntimeTools | null = null;

    constructor(options: RuntimeOptions = {}) {
        const store = options.tokenStore ?? defaultTokenStore();
        const ttl = options.tokenTtlMs ?? resolveApprovalTtlMs();
        this.tokenManager = new ApprovalTokenManager(ttl, store);
    }

    /**
     * Returns the bundle of upstream tools, initializing the AppleScript
     * backend on first call. Throws {@link OutlookNotRunningError} if Outlook
     * isn't running.
     */
    tools(): RuntimeTools {
        if (this.cached != null) return this.cached;
        if (!isOutlookRunning()) {
            throw new OutlookNotRunningError();
        }
        const repository = createAppleScriptRepository();
        const contentReaders: AppleScriptContentReaders = createAppleScriptContentReaders();
        const accountRepository = createAccountRepository();
        const mail = createMailTools(repository, contentReaders.email, contentReaders.attachment);
        const calendar = createCalendarTools(repository, contentReaders.event);
        const contacts = createContactsTools(repository, contentReaders.contact);
        const tasks = createTasksTools(repository, contentReaders.task);
        const notes = createNotesTools(repository, contentReaders.note);
        const org = createMailboxOrganizationTools(repository, this.tokenManager);
        const calendarWriter = createCalendarWriter();
        const calendarManager = createCalendarManager();
        const mailSender = createMailSender();
        this.cached = {
            accountRepository,
            mail,
            calendar,
            contacts,
            tasks,
            notes,
            org,
            calendarWriter,
            calendarManager,
            mailSender,
            tokenManager: this.tokenManager,
        };
        return this.cached;
    }

    /** Direct access to the token manager (for `--help` paths that don't need Outlook). */
    approvals(): ApprovalTokenManager {
        return this.tokenManager;
    }

    /** Resolves the default account id, or throws if no accounts are configured. */
    resolveDefaultAccountId(): number | null {
        return this.tools().accountRepository.getDefaultAccountId();
    }

    /**
     * Maps a user-provided account spec to a list of numeric ids:
     *   - undefined → the default account (or empty if none)
     *   - 'all'     → every configured account
     *   - number    → that single account
     *   - number[]  → exactly those ids
     */
    resolveAccountIds(spec: number | number[] | 'all' | undefined): number[] {
        const tools = this.tools();
        if (spec === undefined) {
            const defaultId = tools.accountRepository.getDefaultAccountId();
            return defaultId !== null ? [defaultId] : [];
        }
        if (spec === 'all') {
            const accounts = tools.accountRepository.listAccounts();
            return accounts.map((acc) => acc.id);
        }
        if (typeof spec === 'number') return [spec];
        return spec;
    }
}
