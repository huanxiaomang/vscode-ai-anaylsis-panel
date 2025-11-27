import * as vscode from 'vscode';

export class Logger {
    private static _outputChannel: vscode.LogOutputChannel;

    public static initialize(context: vscode.ExtensionContext) {
        this._outputChannel = vscode.window.createOutputChannel('AI Code Analyzer', { log: true });
        context.subscriptions.push(this._outputChannel);
    }

    public static info(message: string, ...args: any[]) {
        this._outputChannel.info(message, ...args);
    }

    public static error(message: string | Error, ...args: any[]) {
        this._outputChannel.error(message, ...args);
    }

    public static warn(message: string, ...args: any[]) {
        this._outputChannel.warn(message, ...args);
    }

    public static debug(message: string, ...args: any[]) {
        this._outputChannel.debug(message, ...args);
    }

    public static show() {
        this._outputChannel.show();
    }
}
