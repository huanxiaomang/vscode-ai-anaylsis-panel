import * as vscode from 'vscode';
import { AnalysisResult, TabConfig, TaskState } from './types';

interface PanelState {
    cache: Map<string, AnalysisResult>;
    runningTasks: Map<string, Map<string, TaskState>>;
    currentFile: string;
    tabs: TabConfig[];
    globalState?: vscode.Memento;
}

const state: PanelState = {
    cache: new Map(),
    runningTasks: new Map(),
    currentFile: "",
    tabs: [],
};

export function normalizeKey(path: string): string {
    return vscode.Uri.file(path).toString();
}

export function initState(globalState: vscode.Memento) {
    state.globalState = globalState;
    const saved = globalState.get<[string, AnalysisResult][]>('aiAnalysisCache');
    if (saved) {
        state.cache = new Map(saved);
    }
}

export function getState() {
    return state;
}

export function updateCurrentFile(file: string) {
    state.currentFile = file;
}

export function updateTabs(tabs: TabConfig[]) {
    state.tabs = tabs;
}

export function saveState() {
    if (state.globalState) {
        state.globalState.update('aiAnalysisCache', Array.from(state.cache.entries()));
    }
}

export function updateStaleStatus(key: string, isStale: boolean) {
    const cached = state.cache.get(key);
    if (cached) {
        cached.isStale = isStale;
        saveState();
    }
}

export function clearState() {
    state.cache.clear();
    state.runningTasks.clear();
    saveState();
}
