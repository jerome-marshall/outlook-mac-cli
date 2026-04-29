/**
 * `olk folder` — folder lifecycle operations (non-destructive directly,
 * destructive via prepare/confirm).
 */

import { Command } from 'commander';

import { parsePositiveInt } from '../argv.js';
import { emitError, emitSuccess, type OutputOptions } from '../output.js';
import type { Runtime } from '../runtime.js';

export function buildFolderCommand(runtime: Runtime, getOutput: () => OutputOptions): Command {
    const cmd = new Command('folder').description('Create, rename, move, and delete mail folders.');

    cmd.command('create')
        .description('Create a new mail folder. Defaults to top-level unless --parent is given.')
        .requiredOption('--name <text>', 'Folder name')
        .option('--parent <id>', 'Parent folder id (subfolder mode)', (v) => parsePositiveInt(v, '--parent'))
        .action((opts: { name: string; parent?: number }) => {
            try {
                const result = runtime.tools().org.createFolder({
                    name: opts.name,
                    ...(opts.parent != null && { parent_folder_id: opts.parent }),
                });
                emitSuccess(result, getOutput());
            }
            catch (err) {
                process.exit(emitError(err, getOutput()));
            }
        });

    cmd.command('rename <folderId> <newName>')
        .description('Rename an existing folder.')
        .action((folderId: string, newName: string) => {
            try {
                const result = runtime.tools().org.renameFolder({
                    folder_id: parsePositiveInt(folderId, 'folder-id'),
                    new_name: newName,
                });
                emitSuccess(result, getOutput());
            }
            catch (err) {
                process.exit(emitError(err, getOutput()));
            }
        });

    cmd.command('move <folderId> <destinationParentId>')
        .description('Move a folder under a different parent.')
        .action((folderId: string, destinationParentId: string) => {
            try {
                const result = runtime.tools().org.moveFolder({
                    folder_id: parsePositiveInt(folderId, 'folder-id'),
                    destination_parent_id: parsePositiveInt(destinationParentId, 'destination-parent-id'),
                });
                emitSuccess(result, getOutput());
            }
            catch (err) {
                process.exit(emitError(err, getOutput()));
            }
        });

    cmd.command('prepare-delete <folderId>')
        .description('Prepare to delete a folder and its messages.')
        .action((folderId: string) => {
            try {
                const result = runtime.tools().org.prepareDeleteFolder({
                    folder_id: parsePositiveInt(folderId, 'folder-id'),
                });
                emitSuccess(result, getOutput());
            }
            catch (err) {
                process.exit(emitError(err, getOutput()));
            }
        });

    cmd.command('confirm-delete <tokenId> <folderId>')
        .description('Confirm folder deletion using the token from prepare-delete.')
        .action((tokenId: string, folderId: string) => {
            try {
                const result = runtime.tools().org.confirmDeleteFolder({
                    token_id: tokenId,
                    folder_id: parsePositiveInt(folderId, 'folder-id'),
                });
                emitSuccess(result, getOutput());
            }
            catch (err) {
                process.exit(emitError(err, getOutput()));
            }
        });

    cmd.command('prepare-empty <folderId>')
        .description('Prepare to empty a folder (delete all messages).')
        .action((folderId: string) => {
            try {
                const result = runtime.tools().org.prepareEmptyFolder({
                    folder_id: parsePositiveInt(folderId, 'folder-id'),
                });
                emitSuccess(result, getOutput());
            }
            catch (err) {
                process.exit(emitError(err, getOutput()));
            }
        });

    cmd.command('confirm-empty <tokenId> <folderId>')
        .description('Confirm folder emptying using the token from prepare-empty.')
        .action((tokenId: string, folderId: string) => {
            try {
                const result = runtime.tools().org.confirmEmptyFolder({
                    token_id: tokenId,
                    folder_id: parsePositiveInt(folderId, 'folder-id'),
                });
                emitSuccess(result, getOutput());
            }
            catch (err) {
                process.exit(emitError(err, getOutput()));
            }
        });

    return cmd;
}
