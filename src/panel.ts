import * as vscode from "vscode";

interface TabConfig {
    key: string;
    title: string;
    prompt: string;
}

interface AnalysisResult {
    data: Record<string, string>;
    timestamp: number;
}

interface TaskState {
    result: string;
    abortController: AbortController;
    finished: boolean;
}

export class AIAnalysisPanel {
    public static currentPanel: AIAnalysisPanel | undefined;
    public static readonly viewType = "aiAnalysis";

    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private readonly _globalState: vscode.Memento;
    private _disposables: vscode.Disposable[] = [];
    private _cache = new Map<string, AnalysisResult>();
    private _runningTasks = new Map<string, Map<string, TaskState>>();
    private _currentFile = "";
    private _tabs: TabConfig[] = [];

    public static createOrShow(extensionUri: vscode.Uri, globalState: vscode.Memento, uri?: vscode.Uri) {
        const column = vscode.window.activeTextEditor ? vscode.ViewColumn.Beside : undefined;

        if (AIAnalysisPanel.currentPanel) {
            AIAnalysisPanel.currentPanel._panel.reveal(column);
            if (uri) {
                AIAnalysisPanel.currentPanel.switchFile(uri.fsPath);
            }
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            AIAnalysisPanel.viewType,
            "AI Analysis",
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                localResourceRoots: [vscode.Uri.joinPath(extensionUri, "media")],
                retainContextWhenHidden: true,
            }
        );

        AIAnalysisPanel.currentPanel = new AIAnalysisPanel(panel, extensionUri, globalState);

        // 如果传入了 uri，或者当前有活动编辑器，则初始化显示
        const targetUri = uri || vscode.window.activeTextEditor?.document.uri;
        if (targetUri) {
            AIAnalysisPanel.currentPanel.switchFile(targetUri.fsPath);
        } else {
            AIAnalysisPanel.currentPanel._updateNoFile();
        }
    }

    public static revive(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, globalState: vscode.Memento) {
        AIAnalysisPanel.currentPanel = new AIAnalysisPanel(panel, extensionUri, globalState);
    }

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, globalState: vscode.Memento) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._globalState = globalState;

        // Load cache
        const savedCache = this._globalState.get<any>('aiAnalysisCache');
        if (savedCache) {
            try {
                this._cache = new Map(savedCache);
            } catch (e) {
                console.error('Failed to load cache', e);
            }
        }

        this._update();

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        this._panel.webview.onDidReceiveMessage(
            (m) => m.command === "regenerate" && this.analyzeCurrentFile(true),
            null,
            this._disposables
        );
    }

    public dispose() {
        AIAnalysisPanel.currentPanel = undefined;

        for (const tasks of this._runningTasks.values()) {
            tasks.forEach((t) => t.abortController.abort());
        }
        this._runningTasks.clear();

        // Save cache
        this._globalState.update('aiAnalysisCache', Array.from(this._cache.entries()));
        this._cache.clear();

        this._panel.dispose();
        this._disposables.forEach((d) => d.dispose());
    }

    public showStaleAlert(fileName: string) {
        if (fileName !== this._currentFile) return;
        this._panel.webview.postMessage({ command: "showStaleAlert" });
    }

    public switchFile(fileName: string) {
        if (this._currentFile === fileName) return;
        this._currentFile = fileName;

        const cached = this._cache.get(fileName);
        if (cached) {
            this._panel.webview.postMessage({
                command: "complete",
                fileName,
                data: cached.data,
            });
            return;
        }

        const running = this._runningTasks.get(fileName);
        if (running && [...running.values()].some((t) => !t.finished)) {
            this._pushPartialResults(fileName);
        } else {
            this._panel.webview.postMessage({ command: "reset", fileName });
            // Auto analyze if no cache
            this.analyzeCurrentFile(false);
        }
    }

    public _updateNoFile() {
        this._panel.webview.postMessage({ command: "noFile" });
    }

    private async analyzeCurrentFile(forceRegenerate = false) {
        if (!this._currentFile) {
            const editor = vscode.window.activeTextEditor;
            if (editor) {
                this._currentFile = editor.document.fileName;
            } else {
                return;
            }
        }

        const fileName = this._currentFile;
        // Check if document is open
        const document = vscode.workspace.textDocuments.find(d => d.fileName === fileName) || vscode.window.activeTextEditor?.document;

        if (!document || document.fileName !== fileName) {
            return;
        }

        if (forceRegenerate) {
            this._cache.delete(fileName);
            this._cancelRunningTasks(fileName);
        }

        const cached = this._cache.get(fileName);
        if (cached && !forceRegenerate) {
            this._panel.webview.postMessage({
                command: "complete",
                fileName,
                data: cached.data,
            });
            return;
        }

        this._cancelRunningTasks(fileName);
        this._panel.webview.postMessage({ command: "analyzing", fileName });

        const config = vscode.workspace.getConfiguration("aiAnalyze");
        const apiKey = config.get<string>("apiKey");
        const apiEndpoint = config.get<string>("apiEndpoint");
        const model = config.get<string>("model");
        this._tabs = config.get<TabConfig[]>("tabs") || [];

        if (!apiKey || !apiEndpoint || !model || this._tabs.length === 0) {
            this._panel.webview.postMessage({
                command: "error",
                text: "请配置 API Key、Endpoint、Model 或 aiAnalyze.tabs",
            });
            return;
        }

        const codeContent = document.getText();
        const fileNameOnly = fileName.split(/[\/\\]/).pop() ?? fileName;
        const render = (s: string) =>
            s.replace(/\${fileName}/g, fileNameOnly).replace(/\${codeContent}/g, codeContent);

        const taskMap = new Map<string, TaskState>();
        this._runningTasks.set(fileName, taskMap);

        this._panel.webview.postMessage({
            command: "initTabs",
            tabs: this._tabs.map((t) => ({ key: t.key, title: t.title })),
        });

        const resultData: Record<string, string> = {};
        const result: AnalysisResult = { data: resultData, timestamp: Date.now() };
        this._cache.set(fileName, result);

        this._tabs.forEach((tab) => {
            const abortController = new AbortController();
            const state: TaskState = { result: "", abortController, finished: false };
            taskMap.set(tab.key, state);

            this.callAIStream(
                apiEndpoint!,
                apiKey!,
                model!,
                render(tab.prompt),
                abortController.signal,
                (chunk) => {
                    state.result += chunk;
                    resultData[tab.key] = state.result;
                    this._panel.webview.postMessage({
                        command: "chunk",
                        type: tab.key,
                        text: chunk,
                        fullText: state.result,
                        fileName: fileName // Add fileName to check in webview
                    });
                }
            )
                .then(() => {
                    state.finished = true;
                    this._checkAllFinished(fileName);
                })
                .catch((err) => {
                    if (err.message !== "AbortError") {
                        this._panel.webview.postMessage({
                            command: "error",
                            text: `[${tab.title}] ${err.message}`,
                        });
                    }
                    state.finished = true;
                });
        });
    }

    private _cancelRunningTasks(fileName: string) {
        const tasks = this._runningTasks.get(fileName);
        if (tasks) {
            tasks.forEach((t) => t.abortController.abort());
            this._runningTasks.delete(fileName);
        }
    }

    private _checkAllFinished(fileName: string) {
        const tasks = this._runningTasks.get(fileName);
        if (!tasks) return;

        const allDone = this._tabs.every((t) => tasks.get(t.key)?.finished);
        if (allDone) {
            this._runningTasks.delete(fileName);
            const cached = this._cache.get(fileName)!;
            cached.timestamp = Date.now();
            this._panel.webview.postMessage({
                command: "complete",
                fileName,
                data: cached.data,
            });
        }
    }

    private _pushPartialResults(fileName: string) {
        const cached = this._cache.get(fileName);
        if (!cached) return;
        this._panel.webview.postMessage({
            command: "partial",
            fileName,
            data: cached.data,
        });
    }

    private async callAIStream(
        endpoint: string,
        apiKey: string,
        model: string,
        prompt: string,
        signal: AbortSignal,
        onChunk: (chunk: string) => void
    ): Promise<void> {
        const https = require("https");
        const { URL } = require("url");
        const url = new URL(endpoint);
        const body = JSON.stringify({
            model,
            messages: [{ role: "user", content: prompt }],
            stream: true,
        });

        const options = {
            hostname: url.hostname,
            port: url.port || (url.protocol === "https:" ? 443 : 80),
            path: url.pathname + url.search,
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${apiKey}`,
                "Content-Length": Buffer.byteLength(body),
            },
        };

        return new Promise((resolve, reject) => {
            const req = https.request(options, (res: any) => {
                if (res.statusCode !== 200) {
                    reject(new Error(`HTTP ${res.statusCode}`));
                    return;
                }

                let buffer = "";
                res.on("data", (chunk: Buffer) => {
                    if (signal.aborted) {
                        res.destroy();
                        return;
                    }
                    buffer += chunk.toString();
                    const lines = buffer.split("\n");
                    buffer = lines.pop() || "";

                    for (const line of lines) {
                        if (line.trim() && line.startsWith("data: ")) {
                            const data = line.slice(6);
                            if (data === "[DONE]") continue;
                            try {
                                const json = JSON.parse(data);
                                const content = json.choices?.[0]?.delta?.content;
                                if (content) onChunk(content);
                            } catch { }
                        }
                    }
                });

                res.on("end", resolve);
            });

            req.on("error", reject);
            signal.addEventListener("abort", () => {
                req.destroy();
                reject(new Error("AbortError"));
            });

            req.write(body);
            req.end();
        });
    }

    private _update() {
        this._panel.title = "AI Analysis";
        this._panel.webview.html = this._getHtmlForWebview();
    }

    private _getHtmlForWebview(): string {
        return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <title>AI Analysis</title>
  <style>
    body{font-family:var(--vscode-font-family);margin:0;padding:0;color:var(--vscode-editor-foreground);display:flex;flex-direction:column;height:100vh;background:var(--vscode-editor-background);}
    .toolbar{padding:10px;background:var(--vscode-titleBar-activeBackground);border-bottom:1px solid var(--vscode-panel-border);display:flex;align-items:center;gap:10px;}
    .btn{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;padding:6px 12px;border-radius:4px;cursor:pointer;}
    .btn:hover{background:var(--vscode-button-hoverBackground);}
    .alert{background:#452a2a;border:1px solid #f14c4c;padding:8px;margin:10px;border-radius:4px;display:none;align-items:center;justify-content:space-between;}
    .alert.visible{display:flex;}
    .tabs{display:flex;border-bottom:1px solid var(--vscode-panel-border);background:var(--vscode-sideBar-background);flex-wrap:wrap;}
    .tab{padding:10px 20px;cursor:pointer;opacity:0.7;white-space:nowrap;}
    .tab.active{opacity:1;font-weight:bold;border-bottom:3px solid var(--vscode-editor-foreground);background:var(--vscode-editor-background);}
    .content-area{flex:1;overflow:auto;padding:20px;}
    .tab-content{display:none;}
    .tab-content.active{display:block;}
    .loading{color:var(--vscode-descriptionForeground);font-style:italic;}
  </style>
  <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
</head>
<body>
  <div class="alert" id="staleAlert">
    <span>Warning: 文件已修改，内容可能已过期</span>
    <button class="btn" onclick="regenerate()">重新生成</button>
  </div>
  <div class="toolbar">
    <strong id="fileName">无文件</strong>
    <div style="flex:1"></div>
    <button class="btn" onclick="regenerate()">重新生成</button>
  </div>
  <div class="tabs" id="tabsContainer"></div>
  <div class="content-area" id="contentContainer"></div>

  <script>
    const vscode = acquireVsCodeApi();
    const contents = {};
    let currentFileName = "";

    function regenerate() {
      document.getElementById('staleAlert').classList.remove('visible');
      vscode.postMessage({command:'regenerate'});
      // Show regenerating status immediately
      document.getElementById('fileName').textContent = '正在重新生成...';
    }

    function switchTab(key) {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      document.querySelector(\`[data-key="\${key}"]\`).classList.add('active');
      document.getElementById(key).classList.add('active');
    }

    window.addEventListener('message', e => {
      const m = e.data;
      switch(m.command) {
        case 'initTabs':
          const tabs = document.getElementById('tabsContainer');
          const content = document.getElementById('contentContainer');
          tabs.innerHTML = ''; content.innerHTML = '';
          m.tabs.forEach((tab, i) => {
            const tabEl = document.createElement('div');
            tabEl.className = 'tab' + (i === 0 ? ' active' : '');
            tabEl.dataset.key = tab.key;
            tabEl.textContent = tab.title;
            tabEl.onclick = () => switchTab(tab.key);
            tabs.appendChild(tabEl);

            const div = document.createElement('div');
            div.id = tab.key;
            div.className = 'tab-content' + (i === 0 ? ' active' : '');
            div.innerHTML = '<p class="loading">等待分析...</p>';
            content.appendChild(div);
            contents[tab.key] = '';
          });
          break;

        case 'analyzing':
          currentFileName = m.fileName;
          document.getElementById('fileName').textContent = m.fileName.split(/[\\/]/).pop();
          document.getElementById('staleAlert').classList.remove('visible');
          Object.keys(contents).forEach(k => {
            contents[k] = '';
            document.getElementById(k).innerHTML = '<p class="loading">分析中...</p>';
          });
          break;

        case 'chunk':
          if (m.fileName && m.fileName !== currentFileName) return; // Prevent stream conflict
          contents[m.type] = m.fullText || contents[m.type] + m.text;
          document.getElementById(m.type).innerHTML = marked.parse(contents[m.type]);
          break;

        case 'partial':
        case 'complete':
          currentFileName = m.fileName;
          document.getElementById('fileName').textContent = m.fileName.split(/[\\/]/).pop();
          Object.entries(m.data).forEach(([k, v]) => {
            contents[k] = v || '';
            const el = document.getElementById(k);
            if (el) el.innerHTML = marked.parse(contents[k] || '<p>暂无内容</p>');
          });
          break;

        case 'showStaleAlert':
          document.getElementById('staleAlert').classList.add('visible');
          break;

        case 'error':
          Object.keys(contents).forEach(k => {
            const el = document.getElementById(k);
            if (el) el.innerHTML = '<p style="color:#f14c4c">Error: ' + m.text + '</p>';
          });
          break;

        case 'reset':
          currentFileName = m.fileName;
          document.getElementById('fileName').textContent = m.fileName.split(/[\\/]/).pop();
          document.getElementById('staleAlert').classList.remove('visible');
          document.getElementById('tabsContainer').innerHTML = '';
          document.getElementById('contentContainer').innerHTML = '<p class="loading">准备分析...</p>';
          contents = {};
          break;

        case 'noFile':
           document.getElementById('fileName').textContent = '无文件';
           document.getElementById('tabsContainer').innerHTML = '';
           document.getElementById('contentContainer').innerHTML = '<div style="display:flex;justify-content:center;align-items:center;height:100%;color:var(--vscode-descriptionForeground);">请选择一个文件来查看AI分析内容</div>';
           break;
      }
    });
  </script>
</body>
</html>`;
    }
}