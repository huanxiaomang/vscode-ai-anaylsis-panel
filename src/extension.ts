import * as vscode from 'vscode';
import { AIAnalysisPanel } from './panel';

export function activate(context: vscode.ExtensionContext) {
    console.log('AI Code Analyzer is now active!');

    // 命令：打开 AI 分析面板
    context.subscriptions.push(
        vscode.commands.registerCommand('aiAnalyze.openPreview', (uri?: vscode.Uri) => {
            AIAnalysisPanel.createOrShow(context.extensionUri, context.globalState, uri);
        })
    );

    // 支持 VS Code 关闭后重新打开时恢复 Webview（必须）
    // if (vscode.window.registerWebviewPanelSerializer) {
    //     vscode.window.registerWebviewPanelSerializer(AIAnalysisPanel.viewType, {
    //         async deserializeWebviewPanel(webviewPanel: vscode.WebviewPanel, state: any) {
    //             webviewPanel.webview.options = {
    //                 enableScripts: true,
    //                 localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
    //             };
    //             AIAnalysisPanel.revive(webviewPanel, context.extensionUri, context.globalState);
    //         }
    //     });
    // }

    // 文件保存后 → 仅显示「内容已过期」提示（不自动重新分析）
    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument((doc) => {
            console.log(doc)
            if (AIAnalysisPanel.currentPanel && doc.fileName === AIAnalysisPanel.currentPanel['_currentFile']) {
                AIAnalysisPanel.currentPanel.showStaleAlert(doc.fileName);
            }
        })
    );


    // 核心：左侧编辑器切换文件时，右侧面板自动跟随
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor((editor) => {
            if (editor && AIAnalysisPanel.currentPanel) {
                AIAnalysisPanel.currentPanel.switchFile(editor.document.fileName);
            }
        })
    );

    // 启动时自动打开视图
    //AIAnalysisPanel.createOrShow(context.extensionUri, context.globalState);
}

export function deactivate() { }