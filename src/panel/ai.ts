import * as vscode from 'vscode';
import { getState, normalizeKey, saveState } from './state';
import { postMessage } from './view';
import { Logger } from '../utils/logger';

export async function callAIStream(
    endpoint: string,
    apiKey: string,
    model: string,
    prompt: string,
    signal: AbortSignal,
    onChunk: (chunk: string) => void
): Promise<void> {
    const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: prompt }],
            stream: true,
        }),
        signal,
    });

    if (!response.ok) {
        // Consume the body to prevent connection leaks
        const text = await response.text();
        throw new Error(`HTTP ${response.status}: ${response.statusText} - ${text}`);
    }

    if (!response.body) {
        throw new Error('No response body');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
            if (line.startsWith('data: ') && line.trim() !== 'data: [DONE]') {
                try {
                    const json = JSON.parse(line.slice(6));
                    const content = json.choices?.[0]?.delta?.content;
                    if (content) onChunk(content);
                } catch (e) {
                    // ignore parse errors for partial chunks
                }
            }
        }
    }
}

export async function runSingleTabAnalysis(filePath: string, tabKey: string) {
    const state = getState();
    // Use the passed filePath, do not rely on state.currentFile for the logic execution
    // to ensure atomicity and correctness even if user switches files.

    const document = vscode.workspace.textDocuments.find(d => d.fileName === filePath)
        || vscode.window.activeTextEditor?.document;

    // Double check if the found document actually matches the requested filePath
    if (!document || document.fileName !== filePath) {
        Logger.warn(`⚠️ [AI分析] 无法找到文件内容: ${filePath}`);
        return;
    }

    const tabConfig = state.tabs.find(t => t.key === tabKey);
    if (!tabConfig) return;

    const config = vscode.workspace.getConfiguration("codeInsightPanel");
    const apiKey = config.get<string>("apiKey");
    const apiEndpoint = config.get<string>("apiEndpoint");
    const model = config.get<string>("model");
    const maxParallel = config.get<number>("maxParallelRequests") || 30;

    if (!apiKey || !apiEndpoint || !model) {
        postMessage({ command: "error", text: "请配置 API Key、Endpoint、Model" });
        return;
    }

    // 详细日志：开始请求
    Logger.info(`🚀 [AI分析] 开始请求 tab: ${tabKey}`);
    Logger.info(`   文件: ${filePath}`);
    Logger.info(`   Tab标题: ${tabConfig.title}`);

    // 限制并行
    let totalRunning = 0;
    for (const tasks of state.runningTasks.values()) totalRunning += tasks.size;
    while (totalRunning >= maxParallel) {
        const oldest = [...state.runningTasks.keys()][0];
        if (!oldest || oldest === normalizeKey(filePath)) break;
        cancelAllTasksForKey(oldest);
        state.cache.delete(oldest);
        Logger.info(`   ⚠️  达到并行上限，取消最旧文件: ${oldest}`);
        totalRunning--;
    }

    // Cancel any existing task for this specific tab on this file
    cancelSingleTab(filePath, tabKey);

    const abortController = new AbortController();
    const key = normalizeKey(filePath);
    let taskMap = state.runningTasks.get(key);
    if (!taskMap) {
        taskMap = new Map();
        state.runningTasks.set(key, taskMap);
    }
    taskMap.set(tabKey, { abortController, finished: false });

    // Initialize cache if needed
    let cached = state.cache.get(key);
    if (!cached) {
        cached = { data: {}, status: {}, timestamp: Date.now() };
        state.cache.set(key, cached);
    }

    cached.status[tabKey] = 'generating';
    cached.data[tabKey] = '';
    postMessage({ command: "analyzingTab", tabKey, fileName: filePath });

    const codeContent = document.getText();
    const fileNameOnly = filePath.split(/[\/\\]/).pop() ?? filePath;
    const renderedPrompt = tabConfig.prompt
        .replace(/\${fileName}/g, fileNameOnly)
        .replace(/\${codeContent}/g, codeContent);

    callAIStream(
        apiEndpoint,
        apiKey,
        model,
        renderedPrompt,
        abortController.signal,
        (chunk) => {
            if (cached) {
                cached.data[tabKey] += chunk;
                postMessage({
                    command: "chunk",
                    fileName: filePath,
                    status: cached.status,
                    tabKey,
                    text: chunk,
                    fullText: cached.data[tabKey]
                });
            }
        }
    ).then(() => {
        if (taskMap && taskMap.get(tabKey)) {
            taskMap.get(tabKey)!.finished = true;
        }
        if (cached) {
            cached.status[tabKey] = 'completed';
            cached.isStale = false; // Reset stale status on successful generation
            saveState(); // Save state immediately
        }
        Logger.info(`✅ [AI分析] ${tabKey} 完成 (${filePath})`);
        postMessage({ command: "tabComplete", status: cached.status, tabKey, fileName: filePath, timestamp: Date.now() });
        cleanupIfAllFinished(key, filePath);
    }).catch(err => {
        if (err.name !== "AbortError") {
            Logger.error(`❌ [AI分析] ${tabKey} 失败:`, err.message);
            postMessage({ command: "error", text: `[${tabConfig.title}] ${err.message}` });
        } else {
            Logger.info(`🛑 [AI分析] ${tabKey} 已取消`);
        }
        if (taskMap && taskMap.get(tabKey)) {
            taskMap.get(tabKey)!.finished = true;
        }
        cleanupIfAllFinished(key, filePath);
    });
}

export function cancelSingleTab(filePath: string, tabKey: string) {
    const state = getState();
    const key = normalizeKey(filePath);
    const tasks = state.runningTasks.get(key);
    const task = tasks?.get(tabKey);
    if (task) {
        task.abortController.abort();
        tasks!.delete(tabKey);
        if (tasks!.size === 0) state.runningTasks.delete(key);
    }

    const cached = state.cache.get(key);
    if (cached) cached.status[tabKey] = 'interrupted';

    postMessage({ command: "tabInterrupted", status: cached!.status, tabKey, fileName: filePath });
}

export function cancelAllTasksForFile(filePath: string) {
    const key = normalizeKey(filePath);
    cancelAllTasksForKey(key);
}

export function cancelAllTasks() {
    const state = getState();
    for (const key of state.runningTasks.keys()) {
        cancelAllTasksForKey(key);
    }
}

function cancelAllTasksForKey(key: string) {
    const state = getState();
    const tasks = state.runningTasks.get(key);
    if (!tasks) return;
    tasks.forEach(t => t.abortController.abort());
    state.runningTasks.delete(key);
}

function cleanupIfAllFinished(key: string, filePath: string) {
    const state = getState();
    const tasks = state.runningTasks.get(key);
    if (!tasks) return;
    const allDone = [...tasks.values()].every(t => t.finished);
    if (allDone) {
        state.runningTasks.delete(key);
        const cached = state.cache.get(key);
        if (cached) {
            cached.timestamp = Date.now();
            postMessage({
                command: "analysisDone",
                fileName: filePath,
                timestamp: Date.now()
            });
        }
    }
}