import * as vscode from 'vscode';
import { createOrShow, getPanel, postMessage, registerMessageListener, dispose as disposePanel } from './view';
import { initState, getState, updateCurrentFile, updateTabs, normalizeKey, saveState, getTabs } from './state';
import { runSingleTabAnalysis, cancelSingleTab, cancelAllTasksForFile } from './ai';
import { AnalysisResult, TabConfig } from './types';
import { Logger } from '../utils/logger';

export { getPanel, disposePanel };

export function activatePanel(context: vscode.ExtensionContext, uri?: vscode.Uri) {
    initState(context.globalState);
    createOrShow(context.extensionUri, context.globalState, uri);

    const panel = getPanel();
    if (!panel) return;

    // Initial file switch
    const targetUri = uri || vscode.window.activeTextEditor?.document.uri;
    Logger.info(`Initial file switch: ${targetUri?.fsPath}`);
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
        case "toggleDisable":
            if (message.tabKey) {
                const tabs = getTabs();
                const tab = tabs.find(t => t.key === message.tabKey);
                if (tab) tab.disable = message.disable;
                updateTabs(tabs);
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

    const tabs = getTabs();

    if (cached) {
        // Calculate which tabs need to be requested (none, since we have cache)
        const needRequestArray: string[] = tabs
            .filter(t => !t.disable && cached.status[t.key] !== 'completed')
            .map(t => t.key);
        // Send tabs first, then load cached data
        postMessage({
            command: "initTabs",
            fileName: filePath,
            status: cached.status,
            relativePath: vscode.workspace.asRelativePath(filePath),
            tabs,
            needRequestArray
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

export function notifyThemeChange() {
    postMessage({ command: "themeChanged" });
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

    const tabs = getTabs();

    if (tabs.length === 0) {
        postMessage({ command: "error", text: "请在设置中配置 codeInsightPanel.tabs" });
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

    // Calculate which tabs need to be requested
    const needRequestArray = tabs
        .filter(t => !t.disable)
        .map(t => t.key);

    postMessage({
        command: "initTabs",
        fileName: filePath,
        status: newResult.status,
        relativePath: vscode.workspace.asRelativePath(filePath),
        tabs,
        needRequestArray
    });
}

function sendLoadFileMessage(filePath: string, result: AnalysisResult) {
    postMessage({
        command: "loadFile",
        fileName: filePath,
        relativePath: vscode.workspace.asRelativePath(filePath),
        data: result.data,
        tabs: getTabs(),
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
        tabs: getTabs(),
        status: cached.status,
        timestamp: cached.timestamp
    });
}