"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
const vscode = require("vscode");
const path = require("path");
function activate(context) {
    console.log('CodePulse: Activating...');
    const provider = new PRReviewerWebviewProvider(context);
    vscode.window.showInformationMessage('CodePulse Engine Activated! ⚡');
    context.subscriptions.push(vscode.window.registerWebviewViewProvider('codepulse-view', provider, {
        webviewOptions: { retainContextWhenHidden: true }
    }));
    context.subscriptions.push(vscode.commands.registerCommand('codepulse.analyze', () => {
        provider.analyzeWorkspace();
    }));
}
class PRReviewerWebviewProvider {
    constructor(context) {
        this._context = context;
    }
    resolveWebviewView(webviewView) {
        this._view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                this._context.extensionUri,
                vscode.Uri.file(path.join(this._context.extensionPath, 'dist'))
            ]
        };
        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);
        // Auto-start analysis when extension loads
        this.analyzeWorkspace();
        // Real-time: Refresh analysis when files are saved
        const watcher = vscode.workspace.onDidSaveTextDocument(() => {
            this.analyzeWorkspace();
        });
        this._context.subscriptions.push(watcher);
        // Handle messages from the webview
        webviewView.webview.onDidReceiveMessage(data => {
            switch (data.type) {
                case 'startAnalysis':
                    this.analyzeWorkspace();
                    break;
                case 'showInfo':
                    vscode.window.showInformationMessage(data.value);
                    break;
                case 'openFile':
                    vscode.workspace.openTextDocument(data.path)
                        .then(doc => vscode.window.showTextDocument(doc, { preview: true }));
                    break;
                case 'fixIssue':
                    vscode.window.showInformationMessage(`🔧 Auto-fix triggered for: ${data.issueId}`);
                    break;
                case 'exportReport':
                    this.exportHealthReport(data.data);
                    break;
            }
        });
    }
    async exportHealthReport(reportData) {
        const doc = await vscode.workspace.openTextDocument({
            content: JSON.stringify(reportData, null, 2),
            language: 'json'
        });
        await vscode.window.showTextDocument(doc);
        vscode.window.showInformationMessage('📄 Health Report generated! You can now save this file.');
    }
    async analyzeWorkspace() {
        if (!this._view)
            return;
        this._view.webview.postMessage({ type: 'analysisStarted' });
        const workspaceFolders = vscode.workspace.workspaceFolders;
        const workspaceName = workspaceFolders ? workspaceFolders[0].name : 'Unknown';
        try {
            const files = await vscode.workspace.findFiles('**/*.{ts,tsx,js,jsx,py,vue,svelte}', '**/node_modules/**');
            const godFiles = [];
            const securityIssues = [];
            const performanceIssues = [];
            const unusedFiles = [];
            const allFiles = [];
            let totalLines = 0;
            let progress = 0;
            for (const file of files) {
                progress++;
                const progressPct = Math.round((progress / files.length) * 85);
                this._view.webview.postMessage({ type: 'progress', value: progressPct });
                const doc = await vscode.workspace.openTextDocument(file);
                const text = doc.getText();
                const lines = doc.lineCount;
                const relativePath = vscode.workspace.asRelativePath(file);
                const fileName = path.basename(file.fsPath);
                const ext = path.extname(file.fsPath).replace('.', '');
                // Calculate size by string length if Buffer is tricky in this env
                const size = text.length;
                totalLines += lines;
                const fd = { name: fileName, path: file.fsPath, lines, size, ext };
                allFiles.push(fd);
                // God Files (>500 lines)
                if (lines > 500)
                    godFiles.push(fd);
                // Check for unused/stub files (very small files < 5 lines)
                if (lines < 5 && lines > 0)
                    unusedFiles.push(fd);
                // Security scan (hardcoded secrets)
                const secPatterns = [
                    /(?:API_KEY|APIKEY|api_key|SECRET|PASSWORD|PASSWD|TOKEN|ACCESS_KEY)\s*[:=]\s*['"`][a-zA-Z0-9_\-/+]{8,}['"`]/g,
                    /(?:eyJ[a-zA-Z0-9]{10,})/g, // JWT-like
                    /(?:sk-|pk-)[a-zA-Z0-9]{20,}/g, // OpenAI/Stripe style keys
                ];
                for (const pattern of secPatterns) {
                    const matches = text.match(pattern);
                    if (matches) {
                        securityIssues.push({ file: relativePath, line: 0, match: matches[0].substring(0, 40) + '…' });
                    }
                }
                // Performance: nested loops
                const nestedLoops = text.match(/for\s*\(.*?\)\s*\{[^}]*for\s*\(/g);
                if (nestedLoops) {
                    performanceIssues.push({ file: relativePath, count: nestedLoops.length, type: 'Nested Loops' });
                }
                // Eval usage
                if (/\beval\s*\(/.test(text)) {
                    performanceIssues.push({ file: relativePath, count: 1, type: 'eval() usage' });
                }
            }
            // Weighted health score
            const deductions = (securityIssues.length * 15) +
                (godFiles.length * 5) +
                (performanceIssues.length * 8) +
                (unusedFiles.length * 2);
            const healthScore = Math.max(0, Math.min(100, 100 - deductions));
            this._view.webview.postMessage({ type: 'progress', value: 100 });
            this._view.webview.postMessage({
                type: 'analysisResult',
                data: {
                    healthScore,
                    workspaceName,
                    godFiles, // FileDetail[]
                    securityIssues, // SecurityIssue[]
                    performanceIssues, // PerformanceIssue[]
                    unusedFiles, // FileDetail[]
                    allFiles, // FileDetail[]
                    totalFiles: files.length,
                    totalLines,
                    unusedExports: unusedFiles.length,
                    circularDeps: 0, // Placeholder – full detection needs a dep graph
                    scanProgress: 100,
                    lastScanned: new Date().toLocaleTimeString()
                }
            });
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(`Analysis failed: ${msg}`);
            this._view.webview.postMessage({ type: 'analysisFailed' });
        }
    }
    _getHtmlForWebview(webview) {
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._context.extensionUri, 'dist', 'assets', 'index.js'));
        const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this._context.extensionUri, 'dist', 'assets', 'index.css'));
        const nonce = getNonce();
        console.log('CodePulse: Loading script from:', scriptUri.toString());
        return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline' https:; script-src 'nonce-${nonce}' 'unsafe-eval' https:; img-src ${webview.cspSource} https: data:; connect-src https:;">
  <link href="${styleUri}" rel="stylesheet">
  <title>CodePulse</title>
  <style>
    html, body { height: 100%; margin: 0; padding: 0; overflow: hidden; background-color: #080d17; color: white; }
    #root { height: 100%; }
  </style>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" type="module" src="${scriptUri}"></script>
</body>
</html>`;
    }
}
function getNonce() {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}
