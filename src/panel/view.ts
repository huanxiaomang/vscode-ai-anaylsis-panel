import * as vscode from 'vscode';
import { getState, updateCurrentFile, clearState } from './state';
import { cancelAllTasks, cancelAllTasksForFile } from './ai';

let currentPanel: vscode.WebviewPanel | undefined;
let _disposables: vscode.Disposable[] = [];
let _messageDisposable: vscode.Disposable | undefined;
let _extensionUri: vscode.Uri | undefined;

export function getPanel() {
    return currentPanel;
}

export function postMessage(message: any) {
    currentPanel?.webview.postMessage(message);
}

export function createOrShow(extensionUri: vscode.Uri, globalState: vscode.Memento, uri?: vscode.Uri) {
    _extensionUri = extensionUri;
    const column = vscode.window.activeTextEditor ? vscode.ViewColumn.Beside : undefined;

    if (currentPanel) {
        currentPanel.reveal(column);
        return;
    }

    const panel = vscode.window.createWebviewPanel(
        "Code Insight Panel",
        "AI分析视图",
        column || vscode.ViewColumn.One,
        {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(extensionUri, "media")],
            retainContextWhenHidden: true,
        }
    );

    currentPanel = panel;

    update(panel);

    panel.onDidDispose(() => dispose(), null, _disposables);
}

export function dispose() {
    // If already disposed, do nothing
    if (!currentPanel) {
        return;
    }

    const panel = currentPanel;
    currentPanel = undefined;
    updateCurrentFile('')
    cancelAllTasks();

    // Dispose the panel only if it's not already being disposed by VS Code
    // (We check this by seeing if this function was called from onDidDispose)
    // However, since we set currentPanel = undefined above, subsequent calls won't reach here.
    // The issue is likely that we are calling .dispose() on an already disposing panel
    // or accessing properties of a disposed panel.

    // Actually, the error "Webview is disposed" usually happens when we try to access
    // properties of `currentPanel` AFTER it has been disposed.

    // Clean up disposables
    if (_messageDisposable) {
        _messageDisposable.dispose();
        _messageDisposable = undefined;
    }
    _disposables.forEach(d => d.dispose());
    _disposables = [];
}

async function update(panel: vscode.WebviewPanel) {
    panel.title = "AI分析";
    if (_extensionUri) {
        const htmlPath = vscode.Uri.joinPath(_extensionUri, 'media', 'webview.html');
        try {
            const htmlContent = await vscode.workspace.fs.readFile(htmlPath);
            panel.webview.html = new TextDecoder('utf-8').decode(htmlContent);
        } catch (e) {
            panel.webview.html = `<h1>Error loading HTML</h1><p>${e}</p>`;
        }
    }
}

export function registerMessageListener(callback: (message: any) => void) {
    if (currentPanel) {
        // Clear existing message listener first
        if (_messageDisposable) {
            _messageDisposable.dispose();
            _messageDisposable = undefined;
        }
        // Register new listener
        _messageDisposable = currentPanel.webview.onDidReceiveMessage(callback);
    }
}
