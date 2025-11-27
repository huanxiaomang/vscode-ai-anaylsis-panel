import * as vscode from 'vscode';
import * as panel from './panel';
import { Logger } from './utils/logger';

export function activate(context: vscode.ExtensionContext) {
    Logger.info('AI Code Analyzer is now active!');

    context.subscriptions.push(
        vscode.commands.registerCommand('aiAnalyze.openPreview', (uri?: vscode.Uri) => {
            panel.activatePanel(context, uri);
        })
    );

    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument((doc) => {
            panel.handleFileSave(doc.fileName);
        })
    );

    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor((editor) => {
            if (editor && panel.getPanel()) {
                panel.switchFile(editor.document.fileName);
            }
        })
    );
}

export function deactivate() {
    panel.disposePanel();
}