export interface TabConfig {
    key: string;
    title: string;
    prompt: string;
    active?: boolean;
}

export interface AnalysisResult {
    data: Record<string, string>;
    status: Record<string, 'generating' | 'completed' | 'interrupted'>;
    timestamp: number;
    isStale?: boolean;
}

export interface TaskState {
    abortController: AbortController;
    finished: boolean;
}
