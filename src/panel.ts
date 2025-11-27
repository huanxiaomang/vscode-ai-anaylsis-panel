import * as vscode from "vscode";

interface TabConfig {
    key: string;
    title: string;
    prompt: string;
    active?: boolean;
}

interface AnalysisResult {
    data: Record<string, string>;
    status: Record<string, 'generating' | 'completed' | 'interrupted'>;
    timestamp: number;
}

interface TaskState {
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
            if (uri) AIAnalysisPanel.currentPanel.switchFile(uri.fsPath);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            AIAnalysisPanel.viewType,
            "AI分析视图",
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                localResourceRoots: [vscode.Uri.joinPath(extensionUri, "media")],
                retainContextWhenHidden: true,
            }
        );

        AIAnalysisPanel.currentPanel = new AIAnalysisPanel(panel, extensionUri, globalState);

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

        const saved = globalState.get<[string, AnalysisResult][]>('aiAnalysisCache');
        if (saved) this._cache = new Map(saved);

        this._update();

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        this._panel.webview.onDidReceiveMessage(m => {
            switch (m.command) {
                case "regenerate":
                    this.analyzeCurrentFile(true);
                    break;
                case "requestAnalysis":
                    this.runSingleTabAnalysis(m.tabKey);
                    break;
                case "cancelRequest":
                    this.cancelSingleTab(m.tabKey);
                    break;
                case "openFileLocation":
                    if (this._currentFile) {
                        vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(this._currentFile));
                    }
                    break;
            }
        }, null, this._disposables);
    }

    public dispose() {
        AIAnalysisPanel.currentPanel = undefined;
        for (const tasks of this._runningTasks.values()) {
            tasks.forEach(t => t.abortController.abort());
        }
        this._runningTasks.clear();
        this._globalState.update('aiAnalysisCache', Array.from(this._cache.entries()));
        this._cache.clear();
        this._panel.dispose();
        this._disposables.forEach(d => d.dispose());
        this._disposables = [];
    }

    public showStaleAlert() {
        this._panel.webview.postMessage({ command: "showStaleAlert" });
    }

    public switchFile(filePath: string) {
        if (this._currentFile === filePath) return;
        this._currentFile = filePath;

        const cached = this._cache.get(filePath);
        if (cached) {
            this._sendLoadFileMessage(filePath, cached);
            return;
        }

        const running = this._runningTasks.get(filePath);
        if (running && [...running.values()].some(t => !t.finished)) {
            this._sendPartialMessage(filePath);
        } else {
            this._panel.webview.postMessage({
                command: "reset",
                fileName: filePath,
                relativePath: vscode.workspace.asRelativePath(filePath)
            });
            this.analyzeCurrentFile(false);
        }
    }

    private _updateNoFile() {
        this._panel.webview.postMessage({ command: "noFile" });
    }

    private async analyzeCurrentFile(forceRegenerate: boolean) {
        if (!this._currentFile) {
            const editor = vscode.window.activeTextEditor;
            if (editor) this._currentFile = editor.document.fileName;
            else return;
        }

        const filePath = this._currentFile;
        const document = vscode.workspace.textDocuments.find(d => d.fileName === filePath)
            || vscode.window.activeTextEditor?.document;
        if (!document || document.fileName !== filePath) return;

        if (forceRegenerate) {
            this._cache.delete(filePath);
            this._cancelAllTasksForFile(filePath);
        }

        const cached = this._cache.get(filePath);
        if (cached && !forceRegenerate) {
            this._sendLoadFileMessage(filePath, cached);
            return;
        }

        const config = vscode.workspace.getConfiguration("aiAnalyze");
        this._tabs = config.get<TabConfig[]>("tabs") || [];
        if (this._tabs.length === 0) {
            this._panel.webview.postMessage({ command: "error", text: "请在设置中配置 aiAnalyze.tabs" });
            return;
        }

        const newResult: AnalysisResult = { data: {}, status: {}, timestamp: Date.now() };
        this._cache.set(filePath, newResult);

        this._panel.webview.postMessage({
            command: "initTabs",
            fileName: filePath,
            relativePath: vscode.workspace.asRelativePath(filePath),
            tabs: this._tabs.map(t => ({ key: t.key, title: t.title, active: t.active !== false }))
        });
    }

    private cancelSingleTab(tabKey: string) {
        const filePath = this._currentFile;
        if (!filePath) return;

        const tasks = this._runningTasks.get(filePath);
        const task = tasks?.get(tabKey);
        if (task) {
            task.abortController.abort();
            tasks!.delete(tabKey);
            if (tasks!.size === 0) this._runningTasks.delete(filePath);
        }

        const cached = this._cache.get(filePath);
        if (cached) cached.status[tabKey] = 'interrupted';

        this._panel.webview.postMessage({ command: "tabInterrupted", tabKey });
    }

    private async runSingleTabAnalysis(tabKey: string) {
        const filePath = this._currentFile;
        if (!filePath) return;

        const document = vscode.workspace.textDocuments.find(d => d.fileName === filePath)
            || vscode.window.activeTextEditor?.document;
        if (!document) return;

        const tabConfig = this._tabs.find(t => t.key === tabKey);
        if (!tabConfig) return;

        const config = vscode.workspace.getConfiguration("aiAnalyze");
        const apiKey = config.get<string>("apiKey");
        const apiEndpoint = config.get<string>("apiEndpoint");
        const model = config.get<string>("model");
        const maxParallel = config.get<number>("maxParallelRequests") || 30;

        if (!apiKey || !apiEndpoint || !model) {
            this._panel.webview.postMessage({ command: "error", text: "请配置 API Key、Endpoint、Model" });
            return;
        }

        // 详细日志：开始请求
        console.log(`\n🚀 [AI分析] 开始请求 tab: ${tabKey}`);
        console.log(`   文件: ${filePath}`);
        console.log(`   Tab标题: ${tabConfig.title}`);
        console.log(`   Endpoint: ${apiEndpoint}`);
        console.log(`   Model: ${model}`);
        console.log(`   当前并行数: ${[...this._runningTasks.values()].reduce((s, m) => s + m.size, 0)} / ${maxParallel}`);

        // 限制并行
        let totalRunning = 0;
        for (const tasks of this._runningTasks.values()) totalRunning += tasks.size;
        while (totalRunning >= maxParallel) {
            const oldest = [...this._runningTasks.keys()][0];
            if (!oldest || oldest === filePath) break;
            this._cancelAllTasksForFile(oldest);
            this._cache.delete(oldest);
            console.log(`   ⚠️  达到并行上限，取消最旧文件: ${oldest}`);
            totalRunning--;
        }

        this.cancelSingleTab(tabKey);

        const abortController = new AbortController();
        let taskMap = this._runningTasks.get(filePath);
        if (!taskMap) {
            taskMap = new Map();
            this._runningTasks.set(filePath, taskMap);
        }
        taskMap.set(tabKey, { abortController, finished: false });

        const cached = this._cache.get(filePath)!;
        cached.status[tabKey] = 'generating';
        cached.data[tabKey] = '';
        this._panel.webview.postMessage({ command: "analyzingTab", tabKey });

        const codeContent = document.getText();
        const fileNameOnly = filePath.split(/[\/\\]/).pop() ?? filePath;
        const renderedPrompt = tabConfig.prompt
            .replace(/\${fileName}/g, fileNameOnly)
            .replace(/\${codeContent}/g, codeContent);

        this.callAIStream(
            apiEndpoint,
            apiKey,
            model,
            renderedPrompt,
            abortController.signal,
            (chunk) => {
                cached.data[tabKey] += chunk;
                this._panel.webview.postMessage({
                    command: "chunk",
                    fileName: filePath,
                    tabKey,
                    text: chunk,
                    fullText: cached.data[tabKey]
                });
            }
        ).then(() => {
            taskMap!.get(tabKey)!.finished = true;
            cached.status[tabKey] = 'completed';
            console.log(`✅ [AI分析] ${tabKey} 完成 (${filePath})`);
            this._panel.webview.postMessage({ command: "tabComplete", tabKey, timestamp: Date.now() });
            this._cleanupIfAllFinished(filePath);
        }).catch(err => {
            if (err.message !== "AbortError") {
                console.error(`❌ [AI分析] ${tabKey} 失败:`, err.message);
                this._panel.webview.postMessage({ command: "error", text: `[${tabConfig.title}] ${err.message}` });
            } else {
                console.log(`🛑 [AI分析] ${tabKey} 已取消`);
            }
            taskMap!.get(tabKey)!.finished = true;
            this._cleanupIfAllFinished(filePath);
        });
    }

    private _cancelAllTasksForFile(filePath: string) {
        const tasks = this._runningTasks.get(filePath);
        if (!tasks) return;
        tasks.forEach(t => t.abortController.abort());
        this._runningTasks.delete(filePath);
    }

    private _cleanupIfAllFinished(filePath: string) {
        const tasks = this._runningTasks.get(filePath);
        if (!tasks) return;
        const allDone = [...tasks.values()].every(t => t.finished);
        if (allDone) {
            this._runningTasks.delete(filePath);
            const cached = this._cache.get(filePath);
            if (cached) {
                cached.timestamp = Date.now();
                this._sendAnalysisDoneMessage(filePath);
            }
        }
    }

    // 专用消息：加载已有缓存
    private _sendLoadFileMessage(filePath: string, result: AnalysisResult) {
        this._panel.webview.postMessage({
            command: "loadFile",
            fileName: filePath,
            relativePath: vscode.workspace.asRelativePath(filePath),
            data: result.data,
            status: result.status,
            timestamp: result.timestamp
        });
    }

    // 专用消息：本次分析全部完成
    private _sendAnalysisDoneMessage(filePath: string) {
        this._panel.webview.postMessage({
            command: "analysisDone",
            fileName: filePath,
            timestamp: Date.now()
        });
    }

    private _sendPartialMessage(filePath: string) {
        const cached = this._cache.get(filePath);
        if (!cached) return;
        this._panel.webview.postMessage({
            command: "partial",
            fileName: filePath,
            relativePath: vscode.workspace.asRelativePath(filePath),
            data: cached.data,
            status: cached.status,
            timestamp: cached.timestamp
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
        const { URL } = require("url");
        const url = new URL(endpoint);
        const client = url.protocol === "https:" ? require("https") : require("http");

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
                "Authorization": `Bearer ${apiKey}`,
                "Content-Length": Buffer.byteLength(body),
            },
        };

        return new Promise((resolve, reject) => {
            const req = client.request(options, (res: any) => {
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
                        if (line.startsWith("data: ") && line.trim() !== "data: [DONE]") {
                            try {
                                const json = JSON.parse(line.slice(6));
                                const content = json.choices?.[0]?.delta?.content;
                                if (content) onChunk(content);
                            } catch { }
                        }
                    }
                });
                res.on("end", resolve);
            });

            req.on("error", err => reject(new Error(`Network Error: ${err.message}`)));
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
    ::selection { background: var(--vscode-editor-selectionBackground); color: var(--vscode-editor-selectionForeground); }
    .toolbar{padding:10px;background:var(--vscode-titleBar-activeBackground);border-bottom:1px solid var(--vscode-panel-border);display:flex;align-items:center;gap:10px;}
    .btn{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;padding:6px 12px;border-radius:4px;cursor:pointer;}
    .btn:hover{background:var(--vscode-button-hoverBackground);}
    .bubble-alert{position:absolute;right:100%;top:50%;transform:translateY(-50%);margin-right:12px;background:#333;border:1px solid #f1c40f;color:#fff;padding:5px 10px;border-radius:4px;font-size:12px;white-space:nowrap;display:none;z-index:10;box-shadow:0 2px 5px rgba(0,0,0,0.3);}
    .bubble-alert::after{content:'';position:absolute;top:50%;left:100%;transform:translateY(-50%);border-width:5px;border-style:solid;border-color:transparent transparent transparent #f1c40f;}
    .bubble-alert.visible{display:block;}
    .tabs-container{display:flex;border-bottom:1px solid var(--vscode-panel-border);background:var(--vscode-sideBar-background);}
    .tabs{display:flex;flex:1;flex-wrap:nowrap;overflow-x:auto;}
    .tab{padding:0 15px;height:32px;cursor:pointer;opacity:0.8;white-space:nowrap;display:flex;align-items:center;border-right:1px solid var(--vscode-panel-border);max-width:150px;user-select:none;}
    .tab:hover{background:var(--vscode-list-hoverBackground);}
    .tab.active{opacity:1;font-weight:bold;background:var(--vscode-editor-background);border-bottom:2px solid var(--vscode-progressBar-background);}
    .tab.inactive .tab-title{text-decoration:line-through;opacity:0.6;}
    .tab.inactive{cursor:default;}
    .tab-title{overflow:hidden;text-overflow:ellipsis;margin-right:8px;flex:1;}
    .switch{position:relative;display:inline-block;width:24px;height:14px;flex-shrink:0;}
    .switch input{opacity:0;width:0;height:0;}
    .slider{position:absolute;cursor:pointer;top:0;left:0;right:0;bottom:0;background-color:#ccc;transition:.4s;border-radius:14px;}
    .slider:before{position:absolute;content:"";height:10px;width:10px;left:2px;bottom:2px;background-color:white;transition:.4s;border-radius:50%;}
    input:checked+.slider{background-color:var(--vscode-button-background);}
    input:checked+.slider:before{transform:translateX(10px);}
    .content-area{flex:1;overflow:auto;padding:20px;}
    .tab-content{display:none;}
    .tab-content.active{display:block;}
    .content-header{margin-bottom:20px;padding-bottom:10px;border-bottom:1px solid var(--vscode-panel-border);font-size:12px;color:var(--vscode-descriptionForeground);display:flex;align-items:center;gap:5px;}
    .status-dot{width:8px;height:8px;border-radius:50%;display:inline-block;}
    .status-dot.generating{background:#f1c40f;box-shadow:0 0 5px #f1c40f;}
    .status-dot.completed{background:#2ecc71;}
    .status-dot.interrupted{background:#e74c3c;}
    .action-link{cursor:pointer;display:inline-flex;align-items:center;}
    .action-link:hover{color:var(--vscode-textLink-activeForeground);}
    .action-link.disabled{cursor:not-allowed;opacity:0.6;pointer-events:none;}
    .loading{color:var(--vscode-descriptionForeground);font-style:italic;}
  </style>
  <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
</head>
<body>
  <div class="toolbar">
    <strong id="fileName">无文件</strong>
    <div style="flex:1"></div>
    <div style="position:relative">
        <div class="bubble-alert" id="staleAlert">文件被修改，内容可能已过期</div>
        <button class="btn" onclick="regenerate()">重新生成</button>
    </div>
  </div>
  <div class="tabs-container"><div class="tabs" id="tabsContainer"></div></div>
  <div class="content-area" id="contentContainer"></div>
  <script>
    const vscode = acquireVsCodeApi();
    const contents = {};
    let currentFileName = "";
    let currentRelativePath = "";
    let tabStates = {};
    let tabStatuses = {};
    let lastTimestamp = 0;

    function regenerate() {
      document.getElementById('staleAlert').classList.remove('visible');
      vscode.postMessage({command:'regenerate'});
      document.getElementById('fileName').textContent = '正在重新生成...';
      Object.keys(contents).forEach(k => {
        if (tabStates[k]) {
          contents[k] = '';
          tabStatuses[k] = 'generating';
          const el = document.getElementById(k);
          if(el) el.innerHTML = '<p class="loading">等待分析...</p>';
        }
      });
      updateHeader();
    }

    function switchTab(key) {
      if (!tabStates[key]) return;
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      const tab = document.querySelector(\`[data-key="\${key}"]\`);
      if(tab) tab.classList.add('active');
      const content = document.getElementById(key);
      if(content) content.classList.add('active');
      updateHeader();
    }

    function toggleTab(e, key) {
      e.stopPropagation();
      const isActive = e.target.checked;
      tabStates[key] = isActive;
      const tabEl = document.querySelector(\`[data-key="\${key}"]\`);
      if (isActive) {
        tabEl.classList.remove('inactive');
        if (!contents[key] && tabStatuses[key] !== 'generating') {
          document.getElementById(key).innerHTML = '<p class="loading">分析中...</p>';
          tabStatuses[key] = 'generating';
          vscode.postMessage({ command: 'requestAnalysis', tabKey: key });
        }
      } else {
        tabEl.classList.add('inactive');
        if (tabStatuses[key] === 'generating') {
          tabStatuses[key] = 'interrupted';
          vscode.postMessage({ command: 'cancelRequest', tabKey: key });
        }
      }
      updateHeader();
    }

    function copySource() {
      const activeTab = document.querySelector('.tab.active');
      if(activeTab && contents[activeTab.dataset.key]) {
        navigator.clipboard.writeText(contents[activeTab.dataset.key]);
      }
    }

    function openFile() {
      vscode.postMessage({ command: 'openFileLocation' });
    }

    function formatDate(ts) {
      if (!ts) return '';
      const d = new Date(ts);
      const pad = n => n.toString().padStart(2, '0');
      return \`\${pad(d.getMonth()+1)}/\${pad(d.getDate())} \${pad(d.getHours())}:\${pad(d.getMinutes())}:\${pad(d.getSeconds())}\`;
    }

    function updateHeader() {
      const activeTab = document.querySelector('.tab.active');
      if (!activeTab) return;
      const key = activeTab.dataset.key;
      const status = tabStatuses[key] || 'generating';
      const content = document.getElementById(key);
      if (!content) return;
      let header = content.querySelector('.content-header');
      if (!header) {
        header = document.createElement('div');
        header.className = 'content-header';
        content.prepend(header);
      }
      const timeStr = lastTimestamp ? formatDate(lastTimestamp) : formatDate(Date.now());
      const statusInfo = status === 'completed' ? ['completed', '生成完毕'] :
                        status === 'interrupted' ? ['interrupted', '已中断'] :
                        ['generating', '正在生成'];
      const copyText = status === 'generating' ? '生成完毕后可复制' : '复制当前文档源码';
      const copyClass = status === 'generating' ? 'action-link disabled' : 'action-link';
      header.innerHTML = \`
        <span class="status-dot \${statusInfo[0]}"></span>
        <span>\${statusInfo[1]}</span>
        <span>\${timeStr}</span>
        <span style="flex:1"></span>
        <span class="\${copyClass}" onclick="copySource()">\${copyText}</span>
        <span> | </span>
        <span class="action-link" onclick="openFile()">打开文件位置</span>
      \`;
    }

    window.addEventListener('message', e => {
      const m = e.data;
      switch (m.command) {
        case 'initTabs':
          currentFileName = m.fileName;
          currentRelativePath = m.relativePath || m.fileName;
          document.getElementById('fileName').textContent = currentRelativePath;
          const tabs = document.getElementById('tabsContainer');
          const content = document.getElementById('contentContainer');
          tabs.innerHTML = ''; content.innerHTML = '';
          m.tabs.forEach((tab, i) => {
            tabStates[tab.key] = tab.active;
            tabStatuses[tab.key] = 'generating';
            const tabEl = document.createElement('div');
            tabEl.className = 'tab' + (i === 0 && tab.active ? ' active' : '') + (tab.active ? '' : ' inactive');
            tabEl.dataset.key = tab.key;
            const switchEl = document.createElement('label'); switchEl.className = 'switch';
            const input = document.createElement('input'); input.type = 'checkbox'; input.checked = tab.active;
            input.onchange = e => toggleTab(e, tab.key);
            const slider = document.createElement('span'); slider.className = 'slider';
            switchEl.appendChild(input); switchEl.appendChild(slider);
            const title = document.createElement('span'); title.className = 'tab-title'; title.textContent = tab.title; title.title = tab.title;
            tabEl.appendChild(title); tabEl.appendChild(switchEl);
            tabEl.onclick = e => { if(e.target.tagName !== 'INPUT' && e.target.className !== 'slider') switchTab(tab.key); };
            tabs.appendChild(tabEl);

            const div = document.createElement('div');
            div.id = tab.key;
            div.className = 'tab-content' + (i === 0 && tab.active ? ' active' : '');
            div.innerHTML = '<p class="loading">等待分析...</p>';
            content.appendChild(div);
            contents[tab.key] = '';
            if (tab.active) vscode.postMessage({ command: 'requestAnalysis', tabKey: tab.key });
            else tabStatuses[tab.key] = 'interrupted';
          });
          break;

        case 'analyzingTab':
          tabStatuses[m.tabKey] = 'generating';
          const el = document.getElementById(m.tabKey);
          if (el) { el.innerHTML = '<p class="loading">分析中...</p>'; updateHeader(); }
          break;

        case 'chunk':
          if (m.fileName && m.fileName !== currentFileName) return;
          contents[m.tabKey] = m.fullText;
          const targetEl = document.getElementById(m.tabKey);
          if (targetEl) {
            const header = targetEl.querySelector('.content-header');
            targetEl.innerHTML = marked.parse(m.fullText || '');
            if (header) targetEl.prepend(header);
            else updateHeader();
          }
          break;

        case 'tabComplete':
          tabStatuses[m.tabKey] = 'completed';
          lastTimestamp = m.timestamp;
          updateHeader();
          break;

        case 'tabInterrupted':
          tabStatuses[m.tabKey] = 'interrupted';
          updateHeader();
          break;

        case 'loadFile':    // 切换文件 + 有缓存
          currentFileName = m.fileName;
          currentRelativePath = m.relativePath || m.fileName;
          document.getElementById('fileName').textContent = currentRelativePath;
          lastTimestamp = m.timestamp;
          Object.keys(contents).forEach(k => { contents[k] = ''; delete tabStatuses[k]; });
          Object.entries(m.data || {}).forEach(([k, v]) => {
            contents[k] = v || '';
            tabStatuses[k] = m.status?.[k] || 'completed';
            const el = document.getElementById(k);
            if (el) {
              const header = el.querySelector('.content-header');
              el.innerHTML = marked.parse(contents[k] || '<p>暂无内容</p>');
              if (header) el.prepend(header);
            }
          });
          updateHeader();
          break;

        case 'partial':     // 切换到正在分析中的文件
          currentFileName = m.fileName;
          currentRelativePath = m.relativePath || m.fileName;
          document.getElementById('fileName').textContent = currentRelativePath;
          lastTimestamp = m.timestamp;
          Object.entries(m.data || {}).forEach(([k, v]) => {
            contents[k] = v || '';
            tabStatuses[k] = m.status?.[k] || 'generating';
            const el = document.getElementById(k);
            if (el) {
              el.innerHTML = marked.parse(contents[k] || '<p class="loading">分析中...</p>');
              updateHeader();
            }
          });
          break;

        case 'analysisDone':
          lastTimestamp = m.timestamp;
          updateHeader();
          break;

        case 'showStaleAlert':
          document.getElementById('staleAlert').classList.add('visible');
          break;

        case 'error':
          vscode.window.showErrorMessage(m.text);
          break;

        case 'reset':
          currentFileName = m.fileName;
          currentRelativePath = m.relativePath || m.fileName;
          document.getElementById('fileName').textContent = currentRelativePath;
          document.getElementById('staleAlert').classList.remove('visible');
          document.getElementById('tabsContainer').innerHTML = '';
          document.getElementById('contentContainer').innerHTML = '<p class="loading">准备分析...</p>';
          contents = {}; tabStatuses = {};
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