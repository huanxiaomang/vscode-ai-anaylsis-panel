import * as vscode from 'vscode';
import { createOrShow, getPanel, postMessage, registerMessageListener, dispose as disposePanel } from './view';
import { initState, getState, updateCurrentFile, updateTabs, normalizeKey, saveState } from './state';
import { runSingleTabAnalysis, cancelSingleTab, cancelAllTasksForFile } from './ai';
import { AnalysisResult, TabConfig } from './types';

export { getPanel, disposePanel };

export function activatePanel(context: vscode.ExtensionContext, uri?: vscode.Uri) {
    initState(context.globalState);
    createOrShow(context.extensionUri, context.globalState, uri);

    const panel = getPanel();
    if (!panel) return;

    // Initial file switch
    const targetUri = uri || vscode.window.activeTextEditor?.document.uri;
    if (targetUri) {
        switchFile(targetUri.fsPath);
    } else {
        postMessage({ command: "noFile" });
    }

    // Register message listeners
    registerMessageListener(handleMessage);
}

function handleMessage(message: any) {
    const state = getState();
    // Prefer the fileName sent by the webview if available, otherwise fallback to currentFile
    const targetFile = message.fileName || state.currentFile;

    switch (message.command) {
        case "regenerate":
            if (targetFile) {
                // Regenerate all tabs for the file
                analyzeCurrentFile(true, targetFile);
            }
            break;
        case "requestAnalysis":
            if (targetFile && message.tabKey) {
                runSingleTabAnalysis(targetFile, message.tabKey);
            }
            break;
        case "cancelRequest":
            if (targetFile && message.tabKey) {
                cancelSingleTab(targetFile, message.tabKey);
            }
            break;
        case "openFileLocation":
            if (targetFile) {
                vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(targetFile));
            }
            break;
    }
}

export function switchFile(filePath: string) {
    const state = getState();
    if (state.currentFile === filePath) return;
    updateCurrentFile(filePath);

    const key = normalizeKey(filePath);
    const cached = state.cache.get(key);

    // Get tabs configuration
    const config = vscode.workspace.getConfiguration("aiAnalyze");
    const tabs = config.get<TabConfig[]>("tabs") || [];
    updateTabs(tabs);

    if (cached) {
        // Send tabs first, then load cached data
        postMessage({
            command: "initTabs",
            fileName: filePath,
            relativePath: vscode.workspace.asRelativePath(filePath),
            tabs: tabs.map(t => ({ key: t.key, title: t.title, active: t.active !== false }))
        });
        sendLoadFileMessage(filePath, cached);
        return;
    }

    const running = state.runningTasks.get(key);
    if (running && [...running.values()].some(t => !t.finished)) {
        sendPartialMessage(filePath);
    } else {
        postMessage({
            command: "reset",
            fileName: filePath,
            relativePath: vscode.workspace.asRelativePath(filePath)
        });
        analyzeCurrentFile(false);
    }
}

export function handleFileSave(filePath: string) {
    const key = normalizeKey(filePath);
    const state = getState();

    // Update stale status in cache
    const cached = state.cache.get(key);
    if (cached) {
        cached.isStale = true;
        saveState();
    }

    // If this is the currently viewed file, notify webview
    if (state.currentFile === filePath || normalizeKey(state.currentFile) === key) {
        postMessage({ command: "showStaleAlert", isStale: true });
    }
}

async function analyzeCurrentFile(forceRegenerate: boolean, explicitFilePath?: string) {
    const state = getState();
    let filePath = explicitFilePath || state.currentFile;

    if (!filePath) {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            filePath = editor.document.fileName;
            updateCurrentFile(filePath);
        } else {
            return;
        }
    }

    const key = normalizeKey(filePath);
    const document = vscode.workspace.textDocuments.find(d => d.fileName === filePath)
        || vscode.window.activeTextEditor?.document;
    if (!document || document.fileName !== filePath) return;

    if (forceRegenerate) {
        state.cache.delete(key);
        cancelAllTasksForFile(filePath);
    }

    const cached = state.cache.get(key);
    if (cached && !forceRegenerate) {
        sendLoadFileMessage(filePath, cached);
        return;
    }

    const config = vscode.workspace.getConfiguration("aiAnalyze");
    const tabs = config.get<TabConfig[]>("tabs") || [];
    updateTabs(tabs);

    if (tabs.length === 0) {
        postMessage({ command: "error", text: "请在设置中配置 aiAnalyze.tabs" });
        return;
    }

    const newResult: AnalysisResult = {
        data: {},
        status: {},
        timestamp: Date.now(),
        isStale: false
    };
    state.cache.set(key, newResult);
    saveState(); // Save initial state

    postMessage({
        command: "initTabs",
        fileName: filePath,
        relativePath: vscode.workspace.asRelativePath(filePath),
        tabs: tabs.map(t => ({ key: t.key, title: t.title, active: t.active !== false }))
    });
}

function sendLoadFileMessage(filePath: string, result: AnalysisResult) {
    postMessage({
        command: "loadFile",
        fileName: filePath,
        relativePath: vscode.workspace.asRelativePath(filePath),
        data: result.data,
        status: result.status,
        timestamp: result.timestamp,
        isStale: result.isStale
    });
}

function sendPartialMessage(filePath: string) {
    const state = getState();
    const key = normalizeKey(filePath);
    const cached = state.cache.get(key);
    if (!cached) return;
    postMessage({
        command: "partial",
        fileName: filePath,
        relativePath: vscode.workspace.asRelativePath(filePath),
        data: cached.data,
        status: cached.status,
        timestamp: cached.timestamp
    });
}
