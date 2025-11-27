import * as vscode from 'vscode';
import { getState, updateCurrentFile, clearState } from './state';
import { cancelAllTasks, cancelAllTasksForFile } from './ai';

let currentPanel: vscode.WebviewPanel | undefined;
let _disposables: vscode.Disposable[] = [];
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
        "aiAnalysis",
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
    currentPanel = undefined;

    cancelAllTasks();

    clearState();

    if (currentPanel) {
        (currentPanel as vscode.WebviewPanel).dispose();
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
        // Clear existing listeners first
        _disposables.forEach(d => d.dispose());
        _disposables = [];
        // Register new listener
        _disposables.push(
            currentPanel.webview.onDidReceiveMessage(callback)
        );
    }
}
