import * as vscode from 'vscode';
import { AIAnalysisPanel } from './panel';

export function activate(context: vscode.ExtensionContext) {
	console.log('AI Code Analyzer is now active!');

	context.subscriptions.push(
		vscode.commands.registerCommand('aiAnalyze.openPreview', () => {
			AIAnalysisPanel.createOrShow(context.extensionUri);
		})
	);

	if (vscode.window.registerWebviewPanelSerializer) {
		// Make sure we register a serializer in activation event
		vscode.window.registerWebviewPanelSerializer(AIAnalysisPanel.viewType, {
			async deserializeWebviewPanel(webviewPanel: vscode.WebviewPanel, state: any) {
				console.log(`Got state: ${state}`);
				// Reset the webview options so we use latest uri for `localResourceRoots`.
				webviewPanel.webview.options = getWebviewOptions(context.extensionUri);
				AIAnalysisPanel.revive(webviewPanel, context.extensionUri);
			}
		});
	}

	// Listen for file saves
	context.subscriptions.push(
		vscode.workspace.onDidSaveTextDocument((document) => {
			if (AIAnalysisPanel.currentPanel) {
				// Changed: Instead of auto-analyzing, just alert the user
				AIAnalysisPanel.currentPanel.showStaleAlert(document.fileName);
			}
		})
	);

	// Listen for active editor changes
	context.subscriptions.push(
		vscode.window.onDidChangeActiveTextEditor((editor) => {
			if (editor && AIAnalysisPanel.currentPanel) {
				AIAnalysisPanel.currentPanel.switchFile(editor.document.fileName);
			}
		})
	);
}

function getWebviewOptions(extensionUri: vscode.Uri): vscode.WebviewOptions {
	return {
		// Enable javascript in the webview
		enableScripts: true,

		// And restrict the webview to only loading content from our extension's `media` directory.
		localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')]
	};
}

export function deactivate() {}
