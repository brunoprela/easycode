/**
 * Code context gathering utilities
 * Separated from chatPanel.ts for better maintainability
 */

import * as vscode from 'vscode';
import * as path from 'path';

/**
 * Gather comprehensive code context from the workspace
 * Cursor-like: Includes active editor, workspace structure, and open files
 */
export async function gatherCodeContext(): Promise<string | null> {
    const contextParts: string[] = [];
    
    // 1. Active editor context
    const editor = vscode.window.activeTextEditor;
    if (editor) {
        const document = editor.document;
        const selectedText = editor.selection.isEmpty
            ? null
            : document.getText(editor.selection);
        const language = document.languageId;
        const fileName = path.basename(document.fileName);
        const filePath = document.fileName;

        if (selectedText) {
            contextParts.push(`Currently selected in ${fileName}:\n\`\`\`${language}\n${selectedText}\n\`\`\``);
        } else {
            // Include relevant portion around cursor
            const lineNumber = editor.selection.active.line;
            const startLine = Math.max(0, lineNumber - 20);
            const endLine = Math.min(document.lineCount, lineNumber + 20);
            const contextLines = document.getText(
                new vscode.Range(startLine, 0, endLine, 0)
            );
            contextParts.push(`Current file: ${fileName} (line ${lineNumber + 1})\n\`\`\`${language}\n${contextLines}\n\`\`\``);
        }
    }

    // 2. Workspace structure
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders && workspaceFolders.length > 0) {
        const rootPath = workspaceFolders[0].uri.fsPath;
        try {
            const fs = require('fs');
            const files = fs.readdirSync(rootPath, { withFileTypes: true });
            const fileList = files
                .filter((f: any) => !f.name.startsWith('.') && f.name !== 'node_modules')
                .slice(0, 20)
                .map((f: any) => f.isDirectory() ? `${f.name}/` : f.name)
                .join(', ');
            if (fileList) {
                contextParts.push(`Workspace files: ${fileList}`);
            }
        } catch (e) {
            // Ignore errors reading directory
        }
    }

    // 3. Open files context
    const openFiles = vscode.window.visibleTextEditors
        .map(e => path.basename(e.document.fileName))
        .filter((v, i, a) => a.indexOf(v) === i)
        .slice(0, 5);
    if (openFiles.length > 0) {
        contextParts.push(`Open files: ${openFiles.join(', ')}`);
    }

    return contextParts.length > 0 ? contextParts.join('\n\n') : null;
}

