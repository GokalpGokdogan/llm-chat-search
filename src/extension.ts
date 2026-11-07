// src/extension.ts

import * as vscode from 'vscode';
import * as path from 'path';
import { ChatDataIngester, type ChatSession, type SourceType } from './indexer.js';
import { SidebarProvider } from './sidebarProvider.js';

export function activate(context: vscode.ExtensionContext) {
    console.log('LLM Chat Search Extension is active.');

    const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    // Each workspace gets its own index so switching projects doesn't mix results
    const wsKey = workspacePath
        ? Buffer.from(workspacePath).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 20)
        : 'global';
    const indexPath = path.join(context.globalStorageUri.fsPath, `llm-chat-index-${wsKey}.json`);

    const sidebar = new SidebarProvider(context, indexPath, workspacePath);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(SidebarProvider.viewId, sidebar),
        vscode.commands.registerCommand('llm-chat-search.search', () =>
            vscode.commands.executeCommand('llmChatSearch.sidebar.focus')
        ),
        vscode.commands.registerCommand('llm-chat-search.reindex', async () => {
            await runIngestion(context, indexPath, workspacePath);
            sidebar.refresh();
        }),
        vscode.commands.registerCommand('llm-chat-search.openMatch', (item) => openMatch(item)),
    );
    // autoReindex: fire-and-forget, never awaited
    if (vscode.workspace.getConfiguration('llmChatSearch').get<boolean>('autoReindex')) {
        runIngestion(context, indexPath, workspacePath).then(() => sidebar.refresh());
    }
}

async function runIngestion(
    context: vscode.ExtensionContext,
    indexPath: string,
    workspacePath?: string
): Promise<ChatSession[] | undefined> {
    return vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: 'LLM Chat Search',
            cancellable: false,
        },
        async progress => {
            progress.report({ message: 'Discovering chat logs…' });

            const config = vscode.workspace.getConfiguration('llmChatSearch');
            const extraPaths: string[] = config.get('extraPaths') ?? [];

            const ingester = new ChatDataIngester();
            let sessions: ChatSession[] = [];

            try {
                sessions = await ingester.ingestAll(extraPaths, workspacePath);

                const report = ingester.getDiscoveryReport();
                const sourceSummary = Object.entries(report)
                    .filter(([, n]) => n > 0)
                    .map(([src, n]) => `${src}: ${n}`)
                    .join(', ');

                progress.report({
                    message: `Indexing ${sessions.length} sessions (${sourceSummary || 'scanning…'})…`,
                    increment: 60,
                });

                const { mkdirSync } = await import('fs');
                mkdirSync(context.globalStorageUri.fsPath, { recursive: true });

                await ingester.saveIndex(sessions, indexPath);

                progress.report({ message: `Done — ${sessions.length} sessions indexed.`, increment: 40 });
                vscode.window.showInformationMessage(
                    `LLM Chat Search: indexed ${sessions.length} sessions. Sources: ${sourceSummary || 'none found'}`
                );
            } catch (err) {
                vscode.window.showErrorMessage(`Ingestion failed: ${err}`);
            }

            return sessions;
        }
    );
}

async function openMatch(item: {
    sourceType: SourceType;
    filePath: string;
    chatId: string;
    messageContent: string;
}) {
    // Copy a snippet so the user can paste/search inside the chat panel
    const snippet = item.messageContent.replace(/\s+/g, ' ').slice(0, 80);
    await vscode.env.clipboard.writeText(snippet);

    const tryCommands = async (cmds: string[]): Promise<boolean> => {
        for (const cmd of cmds) {
            try {
                await vscode.commands.executeCommand(cmd);
                return true;
            } catch { /* try next */ }
        }
        return false;
    };

    let opened = false;

    switch (item.sourceType) {
        case 'copilot':
            opened = await tryCommands([
                'workbench.action.chat.history',
                'workbench.action.chat.open',
                'workbench.panel.chat.view.copilot.focus',
                'github.copilot.chat.focus',
            ]);
            if (opened) {
                vscode.window.showInformationMessage(
                    `Opened Copilot Chat. Snippet copied to clipboard — paste in the history search to jump to it.`
                );
                return;
            }
            break;

        case 'continue':
            opened = await tryCommands([
                'continue.viewHistory',
                'continue.continueGUIView.focus',
                'continue.focusContinueInput',
            ]);
            if (opened) {
                vscode.window.showInformationMessage(
                    `Opened Continue.dev. Snippet copied to clipboard — paste in history search to find this chat.`
                );
                return;
            }
            break;
    }

    // Fallback: open the source JSON file
    if (item.filePath) {
        try {
            const uri = vscode.Uri.file(item.filePath);
            const doc = await vscode.workspace.openTextDocument(uri);
            const editor = await vscode.window.showTextDocument(doc);

            // Search for the snippet inside the file and reveal it
            const text = doc.getText();
            const idx = text.indexOf(snippet.slice(0, 40));
            if (idx >= 0) {
                const pos = doc.positionAt(idx);
                editor.selection = new vscode.Selection(pos, pos);
                editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
            }
        } catch {
            vscode.window.showErrorMessage(`Could not open: ${item.filePath}`);
        }
    }
}

export function deactivate() {}
