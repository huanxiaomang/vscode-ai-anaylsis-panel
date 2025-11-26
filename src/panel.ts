import * as vscode from "vscode";

interface AnalysisResult {
    summary: string;
    implementation: string;
    optimization: string;
    timestamp: number;
}

type TaskType = "summary" | "implementation" | "optimization";

interface TaskState {
    result: string;          // 已经收到的完整文本
    abortController: AbortController;
    finished: boolean;
}

export class AIAnalysisPanel {
    public static currentPanel: AIAnalysisPanel | undefined;
    public static readonly viewType = "aiAnalysis";

    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _disposables: vscode.Disposable[] = [];

    // filePath → 完整结果（用于已完成的情况）
    private _cache = new Map<string, AnalysisResult>();

    // filePath → { summary, implementation, optimization } 各自的实时状态
    private _runningTasks = new Map<string, Map<TaskType, TaskState>>();

    private _currentFile: string = "";

    public static createOrShow(extensionUri: vscode.Uri) {
        const column = vscode.window.activeTextEditor
            ? vscode.ViewColumn.Beside
            : undefined;

        if (AIAnalysisPanel.currentPanel) {
            AIAnalysisPanel.currentPanel._panel.reveal(column);
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

        AIAnalysisPanel.currentPanel = new AIAnalysisPanel(panel, extensionUri);
    }

    public static revive(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
        AIAnalysisPanel.currentPanel = new AIAnalysisPanel(panel, extensionUri);
    }

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
        this._panel = panel;
        this._extensionUri = extensionUri;

        this._update();

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
        this._panel.onDidChangeViewState(
            () => {
                if (this._panel.visible) this._update();
            },
            null,
            this._disposables
        );

        this._panel.webview.onDidReceiveMessage(
            (message) => {
                if (message.command === "regenerate") {
                    this.analyzeCurrentFile();
                }
            },
            null,
            this._disposables
        );

        // 打开面板时自动分析当前文件
        this.analyzeCurrentFile();
    }

    public dispose() {
        AIAnalysisPanel.currentPanel = undefined;

        // 取消所有正在进行的请求
        for (const taskMap of this._runningTasks.values()) {
            for (const task of taskMap.values()) {
                task.abortController.abort();
            }
        }
        this._runningTasks.clear();

        this._panel.dispose();
        this._disposables.forEach((d) => d.dispose());
    }

    /** 外部调用：文件内容已变更，显示过期提示 */
    public showStaleAlert(fileName: string) {
        if (fileName !== this._currentFile) return;
        this._panel.webview.postMessage({ command: "showStaleAlert" });
    }

    /** 外部调用：切换到另一个文件 */
    public switchFile(fileName: string) {
        if (this._currentFile === fileName) return;
        this._currentFile = fileName;

        const cached = this._cache.get(fileName);
        if (cached) {
            this._panel.webview.postMessage({
                command: "complete",
                fileName,
                data: cached,
            });
            return;
        }

        // 看看有没有正在进行的任务
        const running = this._runningTasks.get(fileName);
        if (running && [...running.values()].some((t) => !t.finished)) {
            // 有正在跑的任务，直接把当前已有的片段推过去
            this._pushPartialResults(fileName);
        } else {
            this._panel.webview.postMessage({ command: "reset", fileName });
        }
    }

    /** 真正触发当前文件的分析（并行三个任务） */
    private async analyzeCurrentFile() {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;

        const document = editor.document;
        const fileName = document.fileName;
        this._currentFile = fileName;

        // 如果已经有完整缓存，直接使用
        const cached = this._cache.get(fileName);
        if (cached) {
            this._panel.webview.postMessage({
                command: "complete",
                fileName,
                data: cached,
            });
            return;
        }

        // 取消该文件之前未完成的任务（防止重复）
        this._cancelRunningTasks(fileName);

        this._panel.webview.postMessage({ command: "analyzing", fileName });

        const config = vscode.workspace.getConfiguration("aiAnalyze");
        const apiKey = config.get<string>("apiKey");
        const apiEndpoint = config.get<string>("apiEndpoint");
        const model = config.get<string>("model");
        const promptLanguage = config.get<string>("promptLanguage") || "zh-CN";

        if (!apiKey || !apiEndpoint || !model) {
            this._panel.webview.postMessage({
                command: "error",
                text: "请在设置中配置 API Key / Endpoint / Model",
            });
            return;
        }

        const codeContent = document.getText();

        // 初始化三个任务的状态
        const taskMap = new Map<TaskType, TaskState>();
        this._runningTasks.set(fileName, taskMap);

        const prompts: Record<TaskType, string> = {
            summary: `你是一位拥有 10 年以上经验的资深程序员 Leader，正在给新加入项目的成员做代码讲解。

文件名称：${fileName}
代码内容：
\`\`\`
${codeContent}
\`\`\`
你是一位专业的产品经理，请用 Markdown 格式输出以下两部分：

### 1. 文件整体定位（50-80 字）
几句话说明这个文件在整个项目中的角色和核心职责。

### 2. 主要功能点
- 用通俗、产品化的语言描述这个文件“对外提供了什么能力”
- 只能少量出现“实现细节”“具体算法”“变量名”“行号”等技术细节的东西
- 像写**需求文档**一样专业完善客观，毫无遗漏地罗列所有功能点，每个功能点有简明扼要的标题也有根据代码转换过来的详细描述，不可遗漏
- 因为功能点可能内容很多，所以使用列表或表格体现，并且善用分组、标题、小标题等手段去归类和划分核心和不核心的内容，让文档结构清晰，内容条理分明

要求：
- **重点** 理性客观，不夸大，不要像广告或营销号一样堆形容词，你的职责只有描述功能。
- 语言必须让非本文件作者的开发者 1 分钟内看懂
- 绝对不许出现“努力”“优化”“处理”等模糊词
- 如果文件是工具类/配置类/测试文件，必须在第一句话明确点出`,

            implementation: `你是一位技术极深的程序员 Leader，正在给团队做 Code Review 和技术分享。

文件名称：${fileName}
代码内容：
\`\`\`
${codeContent}
\`\`\`

请用 Markdown 格式撰写《实现细节分析》，必须包含以下章节：

### 核心职责与定位（重新简述，50 字以内）
### 整体执行流程（用序号或流程图描述主路径）
### 关键模块/方法拆解（按重要性排序，每部分说明职责与输入输出）
### 重要技术点与实现技巧（包括但不限于：状态管理、错误处理、性能考虑、设计模式、边界处理等）
### 潜在风险点简要提示（不超过 5 条）

要求：
- 所有解释必须基于代码实际内容，不能臆想
- 术语使用精准，结构层次清晰
- 每小节开头用一句话总结该部分核心结论`,

            optimization: `你是一位极其挑剔但又极具建设性的资深程序员 Leader，正在对 ${fileName} 进行正式 Code Review。

代码内容：
\`\`\`
${codeContent}
\`\`\`

请用 Markdown 输出《优化建议报告》，必须包含以下三大板块：

### 一、主要问题（按严重程度排序，每条单独列出）
- 每条格式：【严重/中/轻】问题描述 + 具体位置（行号或函数名）+ 为什么是问题

### 二、优化建议（必须一一对应上面的问题）
- 每条给出具体、可落地的重构方案或改进代码示例
- 如果涉及重构模式，要写出模式名称

### 三、好评定（可选但鼓励）
- 主动指出代码中写得特别好的地方与值得学习的点

要求：
- 必须有具体行号或函数名作为定位
- 不能泛泛而谈“建议优化”“可读性差”
- 如果代码整体优秀，可以大幅减少“主要问题”部分，但“好评定”必须写满
- 语气专业且友善，不允许嘲讽或情绪化语言`,
        };

        // 并行发起三个请求
        (["summary", "implementation", "optimization"] as TaskType[]).forEach((type) => {
            const abortController = new AbortController();
            const state: TaskState = {
                result: "",
                abortController,
                finished: false,
            };
            taskMap.set(type, state);

            this.callAIStream(
                apiEndpoint,
                apiKey,
                model,
                prompts[type],
                abortController.signal,
                (chunk) => {
                    state.result += chunk;
                    // 实时推送到前端
                    this._panel.webview.postMessage({
                        command: "chunk",
                        type,
                        text: chunk,
                        fullText: state.result,
                    });
                    // 同时写入缓存（部分结果）
                    this._savePartialCache(fileName, type, state.result);
                }
            ).then(() => {
                state.finished = true;
                this._checkAllFinished(fileName);
            }).catch((err) => {
                if (err.name !== "AbortError") {
                    this._panel.webview.postMessage({
                        command: "error",
                        text: `[${type}] ${err.message}`,
                    });
                }
                state.finished = true;
            });
        });
    }

    /** 取消该文件所有正在进行的任务 */
    private _cancelRunningTasks(fileName: string) {
        const taskMap = this._runningTasks.get(fileName);
        if (!taskMap) return;
        for (const task of taskMap.values()) {
            task.abortController.abort();
        }
        this._runningTasks.delete(fileName);
    }

    /** 某个任务收到 chunk 时立刻写入缓存（部分结果） */
    private _savePartialCache(fileName: string, type: TaskType, text: string) {
        let cached = this._cache.get(fileName);
        if (!cached) {
            cached = {
                summary: "",
                implementation: "",
                optimization: "",
                timestamp: Date.now(),
            };
            this._cache.set(fileName, cached);
        }
        (cached as any)[type] = text;
    }

    /** 检查该文件三个任务是否全部完成，若完成则推送 complete 消息 */
    private _checkAllFinished(fileName: string) {
        const taskMap = this._runningTasks.get(fileName);
        if (!taskMap) return;

        const allFinished = ["summary", "implementation", "optimization"].every(
            (t) => taskMap.get(t as TaskType)?.finished
        );

        if (allFinished) {
            this._runningTasks.delete(fileName);
            const result = this._cache.get(fileName)!;
            result.timestamp = Date.now();
            this._panel.webview.postMessage({
                command: "complete",
                fileName,
                data: result,
            });
        }
    }

    /** 切换文件时把已有片段推过去（防止卡在 loading） */
    private _pushPartialResults(fileName: string) {
        const cached = this._cache.get(fileName);
        if (!cached) return;

        this._panel.webview.postMessage({
            command: "partial",
            fileName,
            data: {
                summary: cached.summary || "",
                implementation: cached.implementation || "",
                optimization: cached.optimization || "",
            },
        });
    }

    // ====================== 底层 HTTP 流请求 ======================
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
                    buffer = lines.pop() || ""; // 最后可能不完整的一行保留

                    for (const line of lines) {
                        if (!line.trim()) continue;
                        if (line.startsWith("data: ")) {
                            const data = line.slice(6);
                            if (data === "[DONE]") continue;
                            try {
                                const json = JSON.parse(data);
                                const content = json.choices?.[0]?.delta?.content;
                                if (content) onChunk(content);
                            } catch {
                                // ignore malformed line
                            }
                        }
                    }
                });

                res.on("end", () => {
                    resolve();
                });
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

    // ====================== Webview HTML ======================
    private _update() {
        this._panel.title = "AI Analysis";
        this._panel.webview.html = this._getHtmlForWebview(this._panel.webview);
    }

    private _getHtmlForWebview(webview: vscode.Webview) {
        // HTML 部分基本保持不变，只改了几个 message 的处理方式
        return /* html */ `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>AI Analysis</title>
    <style>
        body {font-family:var(--vscode-font-family);margin:0;padding:0;color:var(--vscode-editor-foreground);display:flex;flex-direction:column;height:100vh;background:var(--vscode-editor-background);}
        .toolbar{padding:10px;background:var(--vscode-titleBar-activeBackground);border-bottom:1px solid var(--vscode-panel-border);display:flex;align-items:center;gap:10px;}
        .btn{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;padding:6px 12px;border-radius:4px;cursor:pointer;}
        .btn:hover{background:var(--vscode-button-hoverBackground);}
        .alert{background:#452a2a;border:1px solid #f14c4c;padding:8px;margin:10px;border-radius:4px;display:none;align-items:center;justify-content:space-between;}
        .alert.visible{display:flex;}
        .tabs{display:flex;border-bottom:1px solid var(--vscode-panel-border);background:var(--vscode-sideBar-background);}
        .tab{padding:10px 20px;cursor:pointer;opacity:0.7;}
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
        <span>Warning: 当前文件已修改，内容可能已过期</span>
        <button class="btn" onclick="regenerate()">重新生成</button>
    </div>

    <div class="toolbar">
        <strong id="fileName">无文件</strong>
        <div style="flex:1"></div>
        <button class="btn" onclick="regenerate()">生成</button>
    </div>

    <div class="tabs">
        <div class="tab active" data-tab="summary">内容概览</div>
        <div class="tab" data-tab="implementation">核心实现</div>
        <div class="tab" data-tab="optimization">优化建议</div>
    </div>

    <div class="content-area">
        <div id="summary" class="tab-content active"></div>
        <div id="implementation" class="tab-content"></div>
        <div id="optimization" class="tab-content"></div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        const contents = {summary:"",implementation:"",optimization:""};

        document.querySelectorAll('.tab').forEach(t=>t.onclick=()=>switchTab(t.dataset.tab));
        function switchTab(id){
            document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(c=>c.classList.remove('active'));
            document.querySelector(\`[data-tab="\${id}"]\`).classList.add('active');
            document.getElementById(id).classList.add('active');
        }
        function regenerate(){document.getElementById('staleAlert').classList.remove('visible');vscode.postMessage({command:'regenerate'});}

        window.addEventListener('message', e=>{
            const m = e.data;
            switch(m.command){
                case 'analyzing':
                    document.getElementById('fileName').textContent = m.fileName.split('/').pop();
                    document.getElementById('staleAlert').classList.remove('visible');
                    contents.summary = contents.implementation = contents.optimization = '';
                    ['summary','implementation','optimization'].forEach(id=>document.getElementById(id).innerHTML='<p class="loading">分析中...</p>');
                    break;
                case 'chunk':
                    contents[m.type] = m.fullText || contents[m.type] + m.text;
                    document.getElementById(m.type).innerHTML = marked.parse(contents[m.type]);
                    break;
                case 'partial':
                case 'complete':
                    document.getElementById('fileName').textContent = m.fileName.split('/').pop();
                    contents.summary = m.data.summary || '';
                    contents.implementation = m.data.implementation || '';
                    contents.optimization = m.data.optimization || '';
                    ['summary','implementation','optimization'].forEach(id=>{
                        document.getElementById(id).innerHTML = marked.parse(contents[id] || '<p class="loading">等待内容...</p>');
                    });
                    break;
                case 'reset':
                    document.getElementById('fileName').textContent = m.fileName.split('/').pop();
                    ['summary','implementation','optimization'].forEach(id=>document.getElementById(id).innerHTML='<p class="loading">点击「重新生成」开始分析</p>');
                    break;
                case 'showStaleAlert':
                    document.getElementById('staleAlert').classList.add('visible');
                    break;
                case 'error':
                    ['summary','implementation','optimization'].forEach(id=>document.getElementById(id).innerHTML='<p style="color:#f14c4c">Error: '+m.text+'</p>');
                    break;
            }
        });
    </script>
</body>
</html>`;
    }
}