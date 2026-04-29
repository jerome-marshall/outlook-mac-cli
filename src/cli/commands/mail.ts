/**
 * `olk mail` — every mail-related operation exposed by the upstream tool
 * surface, plus the prepare/confirm destructive subcommands. Each subcommand
 * is a thin commander wrapper around an upstream tool method; argument
 * mapping is done by hand so we can keep `--kebab-case` flags while the
 * tool layer continues to use snake_case fields.
 */

import { readFileSync } from 'node:fs';

import { Command, Option } from 'commander';

import { NotFoundError, ValidationError } from '../../utils/errors.js';
import {
    type SendEmailParams,
    type GetEmailParams,
    type ListEmailsParams,
    type SearchEmailsParams,
    type DownloadAttachmentParams,
    type ListAttachmentsParams,
    type GetUnreadCountParams,
} from '../../tools/mail.js';
import {
    collect,
    parseAttachment,
    parseInlineImage,
    parseNonNegativeInt,
    parsePositiveInt,
    readIdsFromStdin,
    resolveBody,
    splitCsv,
} from '../argv.js';
import { emitError, emitSuccess, type OutputOptions } from '../output.js';
import type { Runtime } from '../runtime.js';

export function buildMailCommand(runtime: Runtime, getOutput: () => OutputOptions): Command {
    const cmd = new Command('mail').description('Read, search, send, and organize Outlook mail.');

    // -------------------------------------------------------------------------
    // Read
    // -------------------------------------------------------------------------

    cmd.command('folders')
        .description('List mail folders, optionally grouped by account.')
        .option('-a, --account-id <id|all>', 'Account id, an "all" literal, or omit for the default account')
        .action((opts: { accountId?: string }) => {
            try {
                const tools = runtime.tools();
                const spec = parseAccountSpec(opts.accountId);
                if (spec === 'all' || Array.isArray(spec)) {
                    const accountIds = runtime.resolveAccountIds(spec);
                    const grouped = tools.accountRepository.listMailFoldersByAccounts(accountIds);
                    const accounts = tools.accountRepository.listAccounts();
                    const items = accountIds.map((accountId) => {
                        const account = accounts.find((a) => a.id === accountId);
                        const folders = grouped
                            .filter((f) => f.accountId === accountId)
                            .map((f) => ({
                                id: f.id,
                                name: f.name,
                                unreadCount: f.unreadCount,
                                messageCount: f.messageCount,
                            }));
                        return {
                            account_id: accountId,
                            account_name: account?.name ?? null,
                            account_email: account?.email ?? null,
                            folders,
                        };
                    });
                    emitSuccess({ items, count: items.length, hasMore: false }, getOutput());
                    return;
                }
                const folders = tools.mail.listFolders({});
                emitSuccess({ items: folders, count: folders.length, hasMore: false }, getOutput());
            }
            catch (err) {
                process.exit(emitError(err, getOutput()));
            }
        });

    cmd.command('list')
        .description('List email summaries in a folder, newest first.')
        .requiredOption('-f, --folder <id>', 'Folder id (e.g., from `olk mail folders`)', (v) => parsePositiveInt(v, '--folder'))
        .option('--limit <n>', 'Maximum results to return (1-100)', (v) => parsePositiveInt(v, '--limit'), 25)
        .option('--offset <n>', 'Pagination offset', (v) => parseNonNegativeInt(v, '--offset'), 0)
        .option('--unread', 'Return only unread emails', false)
        .option('--after <iso>', 'Only include emails received on or after this ISO 8601 date (naked ISO = local time; add Z or offset for UTC/explicit zone)')
        .option('--before <iso>', 'Only include emails received on or before this ISO 8601 date (naked ISO = local time; add Z or offset for UTC/explicit zone)')
        .action((opts: { folder: number; limit: number; offset: number; unread: boolean; after?: string; before?: string }) => {
            try {
                const params: ListEmailsParams = {
                    folder_id: opts.folder,
                    limit: opts.limit,
                    offset: opts.offset,
                    unread_only: opts.unread,
                    ...(opts.after != null && { after: opts.after }),
                    ...(opts.before != null && { before: opts.before }),
                };
                const result = runtime.tools().mail.listEmails(params);
                emitSuccess(result, getOutput());
            }
            catch (err) {
                process.exit(emitError(err, getOutput()));
            }
        });

    cmd.command('unread')
        .description('Shorthand for `mail list --unread`.')
        .requiredOption('-f, --folder <id>', 'Folder id', (v) => parsePositiveInt(v, '--folder'))
        .option('--limit <n>', 'Maximum results (1-100)', (v) => parsePositiveInt(v, '--limit'), 25)
        .option('--offset <n>', 'Pagination offset', (v) => parseNonNegativeInt(v, '--offset'), 0)
        .option('--after <iso>', 'Only include emails received on or after this ISO 8601 date (naked ISO = local time; add Z or offset for UTC/explicit zone)')
        .option('--before <iso>', 'Only include emails received on or before this ISO 8601 date (naked ISO = local time; add Z or offset for UTC/explicit zone)')
        .action((opts: { folder: number; limit: number; offset: number; after?: string; before?: string }) => {
            try {
                const params: ListEmailsParams = {
                    folder_id: opts.folder,
                    limit: opts.limit,
                    offset: opts.offset,
                    unread_only: true,
                    ...(opts.after != null && { after: opts.after }),
                    ...(opts.before != null && { before: opts.before }),
                };
                const result = runtime.tools().mail.listEmails(params);
                emitSuccess(result, getOutput());
            }
            catch (err) {
                process.exit(emitError(err, getOutput()));
            }
        });

    cmd.command('unread-count')
        .description('Return unread count for a folder, or across all folders.')
        .option('-f, --folder <id>', 'Folder id', (v) => parsePositiveInt(v, '--folder'))
        .action((opts: { folder?: number }) => {
            try {
                const params: GetUnreadCountParams = opts.folder != null ? { folder_id: opts.folder } : {};
                const result = runtime.tools().mail.getUnreadCount(params);
                emitSuccess(result, getOutput());
            }
            catch (err) {
                process.exit(emitError(err, getOutput()));
            }
        });

    cmd.command('read <emailId>')
        .description('Read a single email including its body and attachments.')
        .option('--no-body', 'Skip loading the body (metadata only)')
        .option('--no-strip-html', 'Return the raw HTML body instead of plain text')
        .action((emailId: string, opts: { body: boolean; stripHtml: boolean }) => {
            try {
                const params: GetEmailParams = {
                    email_id: parsePositiveInt(emailId, 'email-id'),
                    include_body: opts.body,
                    strip_html: opts.stripHtml,
                };
                const email = runtime.tools().mail.getEmail(params);
                if (email == null) {
                    throw new NotFoundError('Email', parsePositiveInt(emailId, 'email-id'));
                }
                emitSuccess(email, getOutput());
            }
            catch (err) {
                process.exit(emitError(err, getOutput()));
            }
        });

    cmd.command('search <query>')
        .description('Search emails by subject and sender.')
        .option('-f, --folder <id>', 'Limit search to a folder', (v) => parsePositiveInt(v, '--folder'))
        .option('--limit <n>', 'Maximum results (1-200)', (v) => parsePositiveInt(v, '--limit'), 25)
        .option('--offset <n>', 'Pagination offset', (v) => parseNonNegativeInt(v, '--offset'), 0)
        .option('--after <iso>', 'Only include emails received on or after this ISO 8601 date (naked ISO = local time; add Z or offset for UTC/explicit zone)')
        .option('--before <iso>', 'Only include emails received on or before this ISO 8601 date (naked ISO = local time; add Z or offset for UTC/explicit zone)')
        .action((query: string, opts: { folder?: number; limit: number; offset: number; after?: string; before?: string }) => {
            try {
                const params: SearchEmailsParams = {
                    query,
                    limit: opts.limit,
                    offset: opts.offset,
                    ...(opts.folder != null && { folder_id: opts.folder }),
                    ...(opts.after != null && { after: opts.after }),
                    ...(opts.before != null && { before: opts.before }),
                };
                const result = runtime.tools().mail.searchEmails(params);
                emitSuccess(result, getOutput());
            }
            catch (err) {
                process.exit(emitError(err, getOutput()));
            }
        });

    // -------------------------------------------------------------------------
    // Attachments
    // -------------------------------------------------------------------------

    cmd.command('attachments <emailId>')
        .description('List the attachments on an email.')
        .action((emailId: string) => {
            try {
                const params: ListAttachmentsParams = { email_id: parsePositiveInt(emailId, 'email-id') };
                const items = runtime.tools().mail.listAttachments(params);
                emitSuccess({ items, count: items.length, hasMore: false }, getOutput());
            }
            catch (err) {
                process.exit(emitError(err, getOutput()));
            }
        });

    cmd.command('attachment-download <emailId> <attachmentIndex>')
        .description('Download an attachment by 1-based index to disk.')
        .requiredOption('-o, --out <path>', 'Absolute file path to save the attachment')
        .action((emailId: string, attachmentIndex: string, opts: { out: string }) => {
            try {
                const params: DownloadAttachmentParams = {
                    email_id: parsePositiveInt(emailId, 'email-id'),
                    attachment_index: parsePositiveInt(attachmentIndex, 'attachment-index'),
                    save_path: opts.out,
                };
                const result = runtime.tools().mail.downloadAttachment(params);
                emitSuccess(result, getOutput());
            }
            catch (err) {
                process.exit(emitError(err, getOutput()));
            }
        });

    // -------------------------------------------------------------------------
    // Send
    // -------------------------------------------------------------------------

    cmd.command('send')
        .description('Send (or draft-only-fail) an email through the local Outlook account.')
        .requiredOption('--to <addresses>', 'Comma-separated recipient list')
        .requiredOption('--subject <text>', 'Subject line')
        .option('--body <text>', 'Body content (use --body-file for newline-heavy content)')
        .option('--body-file <path>', 'Read body content from a file (or "-" for stdin)')
        .option('--cc <addresses>', 'Comma-separated CC recipients')
        .option('--bcc <addresses>', 'Comma-separated BCC recipients')
        .option('--reply-to <address>', 'Reply-To address')
        .option('--attach <path[:name]>', 'Attach a file (repeatable). Optional `:name` overrides the display name.', collect, [] as string[])
        .option('--inline-image <cid=path>', 'Embed an inline image (repeatable; HTML body only).', collect, [] as string[])
        .option('--account-id <id>', 'Send from a specific account id', (v) => parsePositiveInt(v, '--account-id'))
        .option('--html', 'Treat the body as HTML', false)
        .option('--send', 'Actually transmit the message. Without this flag the CLI refuses to send.', false)
        .action((opts: {
            to: string;
            subject: string;
            body?: string;
            bodyFile?: string;
            cc?: string;
            bcc?: string;
            replyTo?: string;
            attach: string[];
            inlineImage: string[];
            accountId?: number;
            html: boolean;
            send: boolean;
        }) => {
            try {
                if (!opts.send) {
                    throw new ValidationError(
                        'Refusing to send without --send. ' +
                        'The current AppleScript backend cannot create drafts in v1; pass --send to confirm transmission.',
                    );
                }
                const to = splitCsv(opts.to) ?? [];
                if (to.length === 0) throw new ValidationError('--to must include at least one address');
                const body = resolveBody(opts.body, opts.bodyFile);
                const params: SendEmailParams = {
                    to,
                    subject: opts.subject,
                    body,
                    body_type: opts.html ? 'html' : 'plain',
                    ...(splitCsv(opts.cc) != null && { cc: splitCsv(opts.cc) as string[] }),
                    ...(splitCsv(opts.bcc) != null && { bcc: splitCsv(opts.bcc) as string[] }),
                    ...(opts.replyTo != null && { reply_to: opts.replyTo }),
                    ...(opts.attach.length > 0 && {
                        attachments: opts.attach.map(parseAttachment),
                    }),
                    ...(opts.inlineImage.length > 0 && {
                        inline_images: opts.inlineImage.map(parseInlineImage),
                    }),
                    ...(opts.accountId != null && { account_id: opts.accountId }),
                };
                const sent = runtime.tools().mailSender.sendEmail({
                    to: params.to,
                    subject: params.subject,
                    body: params.body,
                    bodyType: params.body_type,
                    ...(params.cc != null && { cc: params.cc }),
                    ...(params.bcc != null && { bcc: params.bcc }),
                    ...(params.reply_to != null && { replyTo: params.reply_to }),
                    ...(params.attachments != null && { attachments: params.attachments }),
                    ...(params.inline_images != null && {
                        inlineImages: params.inline_images.map((img) => ({
                            path: img.path,
                            contentId: img.content_id,
                        })),
                    }),
                    ...(params.account_id != null && { accountId: params.account_id }),
                });
                emitSuccess({
                    messageId: sent.messageId,
                    sentAt: sent.sentAt,
                    status: 'sent',
                }, getOutput());
            }
            catch (err) {
                process.exit(emitError(err, getOutput()));
            }
        });

    // -------------------------------------------------------------------------
    // Mark / flag / categories
    // -------------------------------------------------------------------------

    cmd.command('mark <emailId> <state>')
        .description('Mark an email as read or unread.')
        .action((emailId: string, state: string) => {
            try {
                if (state !== 'read' && state !== 'unread') {
                    throw new ValidationError(`mark <state> must be 'read' or 'unread' (got ${JSON.stringify(state)})`);
                }
                const id = parsePositiveInt(emailId, 'email-id');
                const result = state === 'read'
                    ? runtime.tools().org.markEmailRead({ email_id: id })
                    : runtime.tools().org.markEmailUnread({ email_id: id });
                emitSuccess(result, getOutput());
            }
            catch (err) {
                process.exit(emitError(err, getOutput()));
            }
        });

    cmd.command('flag <emailId>')
        .description('Set or clear the follow-up flag on an email.')
        .addOption(new Option('--status <state>', 'Flag status').choices(['none', 'flagged', 'completed']).default('flagged'))
        .action((emailId: string, opts: { status: 'none' | 'flagged' | 'completed' }) => {
            try {
                const id = parsePositiveInt(emailId, 'email-id');
                const flagStatus = opts.status === 'none' ? 0 : opts.status === 'flagged' ? 1 : 2;
                const result = runtime.tools().org.setEmailFlag({ email_id: id, flag_status: flagStatus });
                emitSuccess(result, getOutput());
            }
            catch (err) {
                process.exit(emitError(err, getOutput()));
            }
        });

    cmd.command('categories <emailId>')
        .description('Set or clear categories on an email.')
        .option('--set <list>', 'Comma-separated categories to set')
        .option('--clear', 'Clear all categories', false)
        .action((emailId: string, opts: { set?: string; clear: boolean }) => {
            try {
                const id = parsePositiveInt(emailId, 'email-id');
                let categories: string[];
                if (opts.clear) {
                    categories = [];
                }
                else if (opts.set != null) {
                    categories = splitCsv(opts.set) ?? [];
                }
                else {
                    throw new ValidationError('Either --set <list> or --clear must be provided');
                }
                const result = runtime.tools().org.setEmailCategories({ email_id: id, categories });
                emitSuccess(result, getOutput());
            }
            catch (err) {
                process.exit(emitError(err, getOutput()));
            }
        });

    // -------------------------------------------------------------------------
    // Destructive single-target prepare/confirm
    // -------------------------------------------------------------------------

    cmd.command('prepare-delete <emailId>')
        .description('Prepare to delete (move to Deleted Items). Returns a token.')
        .action((emailId: string) => withRuntime(() => runtime.tools().org.prepareDeleteEmail({
            email_id: parsePositiveInt(emailId, 'email-id'),
        }), getOutput));

    cmd.command('confirm-delete <tokenId> <emailId>')
        .description('Confirm a delete using the token from prepare-delete.')
        .action((tokenId: string, emailId: string) => withRuntime(() => runtime.tools().org.confirmDeleteEmail({
            token_id: tokenId,
            email_id: parsePositiveInt(emailId, 'email-id'),
        }), getOutput));

    cmd.command('prepare-move <emailId> <destinationFolderId>')
        .description('Prepare to move an email to another folder.')
        .action((emailId: string, destinationFolderId: string) => withRuntime(() => runtime.tools().org.prepareMoveEmail({
            email_id: parsePositiveInt(emailId, 'email-id'),
            destination_folder_id: parsePositiveInt(destinationFolderId, 'destination-folder-id'),
        }), getOutput));

    cmd.command('confirm-move <tokenId> <emailId>')
        .description('Confirm a move using the token from prepare-move.')
        .action((tokenId: string, emailId: string) => withRuntime(() => runtime.tools().org.confirmMoveEmail({
            token_id: tokenId,
            email_id: parsePositiveInt(emailId, 'email-id'),
        }), getOutput));

    cmd.command('prepare-archive <emailId>')
        .description('Prepare to archive an email.')
        .action((emailId: string) => withRuntime(() => runtime.tools().org.prepareArchiveEmail({
            email_id: parsePositiveInt(emailId, 'email-id'),
        }), getOutput));

    cmd.command('confirm-archive <tokenId> <emailId>')
        .description('Confirm an archive using the token from prepare-archive.')
        .action((tokenId: string, emailId: string) => withRuntime(() => runtime.tools().org.confirmArchiveEmail({
            token_id: tokenId,
            email_id: parsePositiveInt(emailId, 'email-id'),
        }), getOutput));

    cmd.command('prepare-junk <emailId>')
        .description('Prepare to mark an email as junk.')
        .action((emailId: string) => withRuntime(() => runtime.tools().org.prepareJunkEmail({
            email_id: parsePositiveInt(emailId, 'email-id'),
        }), getOutput));

    cmd.command('confirm-junk <tokenId> <emailId>')
        .description('Confirm marking as junk using the token from prepare-junk.')
        .action((tokenId: string, emailId: string) => withRuntime(() => runtime.tools().org.confirmJunkEmail({
            token_id: tokenId,
            email_id: parsePositiveInt(emailId, 'email-id'),
        }), getOutput));

    // -------------------------------------------------------------------------
    // Batch destructive
    // -------------------------------------------------------------------------

    cmd.command('prepare-batch-delete')
        .description('Prepare to delete multiple emails. Reads ids from stdin (newline or comma separated).')
        .action(() => {
            try {
                const ids = readIdsFromStdin();
                if (ids.length === 0) throw new ValidationError('No email ids provided on stdin');
                const result = runtime.tools().org.prepareBatchDeleteEmails({ email_ids: ids });
                emitSuccess(result, getOutput());
            }
            catch (err) {
                process.exit(emitError(err, getOutput()));
            }
        });

    cmd.command('prepare-batch-move <destinationFolderId>')
        .description('Prepare to move multiple emails. Reads ids from stdin.')
        .action((destinationFolderId: string) => {
            try {
                const ids = readIdsFromStdin();
                if (ids.length === 0) throw new ValidationError('No email ids provided on stdin');
                const result = runtime.tools().org.prepareBatchMoveEmails({
                    email_ids: ids,
                    destination_folder_id: parsePositiveInt(destinationFolderId, 'destination-folder-id'),
                });
                emitSuccess(result, getOutput());
            }
            catch (err) {
                process.exit(emitError(err, getOutput()));
            }
        });

    cmd.command('confirm-batch')
        .description('Confirm a batch operation. Reads `tokenId,emailId` pairs from stdin (one per line).')
        .action(() => {
            try {
                const pairs = readBatchPairsFromStdin();
                if (pairs.length === 0) throw new ValidationError('No token/email pairs provided on stdin');
                const result = runtime.tools().org.confirmBatchOperation({ tokens: pairs });
                emitSuccess(result, getOutput());
            }
            catch (err) {
                process.exit(emitError(err, getOutput()));
            }
        });

    return cmd;
}

/** Reads `tokenId,emailId` (or whitespace-separated) pairs from stdin. */
function readBatchPairsFromStdin(): { token_id: string; email_id: number }[] {
    const stdin = readFileSync(0, 'utf8');
    const lines = stdin.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
    return lines.map((line, idx) => {
        const [token, id] = line.split(/[\s,]+/).filter((s) => s.length > 0);
        if (token == null || id == null) {
            throw new ValidationError(`Invalid batch pair at line ${idx + 1}: ${JSON.stringify(line)}`);
        }
        return { token_id: token, email_id: parsePositiveInt(id, 'email-id') };
    });
}

/** Translates an `--account-id` argv value into the runtime account spec. */
function parseAccountSpec(raw?: string): number | number[] | 'all' | undefined {
    if (raw == null) return undefined;
    if (raw === 'all') return 'all';
    if (raw.includes(',')) {
        return raw.split(',').map((part) => parsePositiveInt(part.trim(), '--account-id'));
    }
    return parsePositiveInt(raw, '--account-id');
}

/** Wraps a synchronous tool call in the standard success/error emit. */
function withRuntime<T>(fn: () => T, getOutput: () => OutputOptions): void {
    try {
        const result = fn();
        emitSuccess(result, getOutput());
    }
    catch (err) {
        process.exit(emitError(err, getOutput()));
    }
}
