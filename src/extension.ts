import * as vscode from 'vscode';
import { ChatPanel } from './chatPanel';

let chatPanel: ChatPanel | undefined;

function createOrShowChatPanel(context: vscode.ExtensionContext) {
    if (chatPanel) {
        chatPanel.reveal();
    } else {
        // Always open on the right side (ViewColumn.Two or Three)
        // Try to find an available column on the right
        let targetColumn = vscode.ViewColumn.Two;
        
        // If there are multiple editors open, use the rightmost one
        const visibleEditors = vscode.window.visibleTextEditors;
        if (visibleEditors.length > 0) {
            const rightmostColumn = Math.max(...visibleEditors.map(e => e.viewColumn || 1));
            // Use the next column to the right, or Three if already at Two
            targetColumn = rightmostColumn >= 2 ? vscode.ViewColumn.Three : vscode.ViewColumn.Two;
        }

        const panel = vscode.window.createWebviewPanel(
            'easycode.chatView',
            'EasyCode Chat',
            targetColumn,
            {
                enableScripts: true,
                localResourceRoots: [
                    vscode.Uri.joinPath(context.extensionUri, 'media'),
                    vscode.Uri.joinPath(context.extensionUri, 'out')
                ],
                retainContextWhenHidden: true
            }
        );

        chatPanel = new ChatPanel(panel, context.extensionUri);
        panel.onDidDispose(() => {
            chatPanel = undefined;
        }, null, context.subscriptions);
    }
}

export function activate(context: vscode.ExtensionContext) {
    console.log('EasyCode extension is now active!');

    // Register the command to open the chat panel
    const openChatCommand = vscode.commands.registerCommand('easycode.openChat', () => {
        createOrShowChatPanel(context);
    });

    context.subscriptions.push(openChatCommand);

    // Auto-open chat panel on activation (like Cursor)
    createOrShowChatPanel(context);
}

export function deactivate() {
    if (chatPanel) {
        chatPanel.dispose();
    }
}

