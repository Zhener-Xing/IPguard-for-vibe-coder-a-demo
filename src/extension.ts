// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import * as babelparser from '@babel/parser';
import fs from 'fs';
import { spawn } from 'child_process';
import * as path from 'path';
import * as traverse from '@babel/traverse';
import * as t from '@babel/types';
import * as ts from 'typescript';
import * as crypto from 'crypto';
import * as os from 'os';
import { Fingerprint, WinnowingMode } from 'scanoss';
import { analyzeScanReport } from './llmservice';

const SKIP_KEYS = new Set(['loc', 'start', 'end', 'range', 'extra', 'leadingComments', 'trailingComments', 'innerComments']);
const UNWRAP_TYPES = new Set(['ParenthesizedExpression', 'TSAsExpression', 'TSTypeAssertion', 'TSNonNullExpression']);
const LITERAL_TYPES = new Set(['StringLiteral', 'NumericLiteral', 'BooleanLiteral', 'NullLiteral', 'BigIntLiteral', 'Literal']);
const SCANOSS_API = 'https://api.osskb.org/scan/direct';

export function normalizeAST(ast: any): any {
	if (Array.isArray(ast)) {
		return ast.map(normalizeAST).filter(item => item !== null);
	}//历遍节点
	if (ast === null || typeof ast !== 'object') {
		return ast;
	}//空的直接返回
	if (UNWRAP_TYPES.has(ast.type)) {
		return normalizeAST(ast.expression);
	}//解包表达式
	if (ast.type === 'EmptyStatement') {
		return null;
	}//空语句直接返回null
	if (ast.type === 'RegExpLiteral') {
		return { type: 'Literal', regex: ast.pattern, flags: ast.flags };
	}//正则表达式特殊处理
	const cleaned: Record<string, any> = {};
	for (const key in ast) {
		if (SKIP_KEYS.has(key)) continue;//跳过不重要的属性
		cleaned[key] = normalizeAST(ast[key]);
	}//清理节点属性，递归处理子节点
	if (LITERAL_TYPES.has(cleaned.type)) {
		return { type: 'Literal', value: cleaned.value ?? null };
	}//统一字面量节点
	if (cleaned.type === 'ObjectExpression' && Array.isArray(cleaned.properties)) {
		const keyOf = (prop: any): string => {
			const k = prop?.key;
			if (!k) return '\uffff';
			if (prop.computed) return '\ufffe' + JSON.stringify(k);
			if (k.type === 'Identifier') return k.name;
			if (k.type === 'Literal') return String(k.value);
			return '';
		};//对象属性排序，computed属性排在最后
		cleaned.properties.sort((a: any, b: any) => keyOf(a).localeCompare(keyOf(b)));
	}
	return cleaned;//返回清理后的节点
}//AST标准化函数。

export function astFingerprint(normalizedAst: any): string {
	const canonical = JSON.stringify(normalizedAst);//将标准化 AST 序列化为稳定字符串
	return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');//SHA-256 十六进制指纹
}//标准化 AST 指纹函数。

async function sourceToWfp(filePath: string, code: string): Promise<string> {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipguard-wfp-'));
	try {
		const tmpFile = path.join(tmpDir, path.basename(filePath));
		fs.writeFileSync(tmpFile, code, 'utf8');
		const wfpPath = path.join(tmpDir, 'out.wfp');
		const fp = new Fingerprint();
		fp.setFingerprintPath(wfpPath);
		await new Promise<void>((resolve, reject) => {
			fp.once('WINNOWING_FINISHED', () => resolve());
			fp.on('error', reject);
			fp.start([{ folderRoot: tmpDir, fileList: [tmpFile], winnowingMode: WinnowingMode.FULL_WINNOWING }]).catch(reject);
		});
		return fs.readFileSync(wfpPath, 'utf8');
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
}//源码 → Winnowing（WFP）指纹

type ScanossHit = {
	id?: string;
	component?: string;
	lines?: string;
	oss_lines?: string;
	matched?: string;
	licenses?: Array<{ name?: string }>;
	file?: string;
};//格式化SCANOSS比对结果

function formatScanossHit(h: ScanossHit): string {
	const lic = h.licenses?.map((l) => l.name).filter(Boolean).join(', ') || '—';
	return [
		h.component ?? h.id ?? 'unknown',
		`license: ${lic}`,
		`lines: ${h.lines ?? '—'}`,
		`oss_lines: ${h.oss_lines ?? '—'}`,
		`matched: ${h.matched ?? '—'}`,
		h.file ? `oss_file: ${h.file}` : '',
	].filter(Boolean).join(' | ');
}//格式化SCANOSS比对结果为可读字符串

async function scanossCompare(filePath: string, wfp: string): Promise<ScanossHit[]> {
	try {
		const form = new FormData();
		form.append('file', new Blob([wfp], { type: 'text/plain' }), 'scan.wfp');
		const res = await fetch(SCANOSS_API, { method: 'POST', body: form });
		const data = (await res.json()) as Record<string, ScanossHit[]>;
		return Object.values(data).flat().filter((r) => r.id && r.id !== 'none');
	} catch (error) {
		console.error(`SCANOSS failed for ${filePath}:`, error);
		return [];
	}
}//WFP 与 SCANOSS 开源知识库比对
function buildScanossReport(filePath: string, hits: ScanossHit[]): string {
	if (hits.length === 0) {
		return `No matches found for ${filePath}. No risk of license violation.`;
	}
	const lines = hits.map((h, i) => `${i + 1}. ${formatScanossHit(h)}`).join('\n');
	return `File: ${filePath}\n${hits.length} match(es):\n${lines}\n`;
}
//构建SCANOSS比对报告

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {

	// Use the console to output diagnostic information (console.log) and errors (console.error)
	// This line of code will only be executed once when your extension is activated
	console.log('Congratulations, your extension "IPguard" is now active!');

	const output = vscode.window.createOutputChannel('IPguard');//创建标签页显示LLM返回的信息

	// The command has been defined in the package.json file
	// Now provide the implementation of the command with registerCommand
	// The commandId parameter must match the command field in package.json
	const disposable = vscode.commands.registerCommand('call.IPguard', async () => {
		const report: string[] = [];
		const workspaceFolders = vscode.workspace.workspaceFolders;
		if (!workspaceFolders) {
			vscode.window.showErrorMessage('Please open a workspace folder.');
			return;
		}//检查是否有打开的工作区文件夹，如果没有则提示用户打开一个工作区文件夹
		const files = await vscode.workspace.findFiles(
			'**/*.{js,py}',
			'**/{node_modules,dist,.git,.vscode}/**'
		);//查找工作区中所有的js和py文件，排除掉node_modules、dist、.git和.vscode文件夹中的文件
		const jsFiles = files.filter(uri => uri.fsPath.endsWith('.js'));
		const pyFiles = files.filter(uri => uri.fsPath.endsWith('.py'));//过滤出js和py文件
		const jsFilePaths = jsFiles.map(uri => uri.fsPath);
		//获取js和py文件的路径
		for (const filePath of jsFilePaths) {
			try{
			    const fileUri = vscode.Uri.file(filePath);
                const uint8Array = await vscode.workspace.fs.readFile(fileUri);
        		const code = new TextDecoder('utf-8').decode(uint8Array);//读取js文件的内容
				//为了防止出现不兼容问题，使用vscode自己的文件系统抽象层来解码

				const ast = babelparser.parse(code, {
					sourceType: 'unambiguous',//自动检测代码是模块还是脚本
					plugins: ['jsx', 'typescript'],//支持jsx和typescript语法
					ranges: true,//在抽象语法树中包含节点的开始和结束位置
					attachComment: true,//在抽象语法树中包含注释信息
					errorRecovery: true,//在解析过程中遇到错误时继续解析
				});//解析js文件生成抽象语法树

				//console.log(`AST for file ${filePath}:`, ast);//测试信息
				const normalizedAst = normalizeAST(ast);
				//console.log(`Normalized AST for file ${filePath}:`, normalizedAst);//测试信息
				const fingerprint = astFingerprint(normalizedAst);
				//console.log(`Fingerprint for file ${filePath}:`, fingerprint);//测试信息
				const wfp = await sourceToWfp(filePath, code);//生成 Winnowing指纹
				//console.log(`WFP for ${filePath} has been generated.`);//测试信息
				const hits= await scanossCompare(filePath, wfp);//进行大量在线比对
				report.push(buildScanossReport(filePath, hits));
				//生成标准化的抽象语法树与指纹。
			}catch (error) {
				console.error(`Error parsing file ${filePath}:`, error);
			}//解析js文件时，如果发生错误则输出错误信息
		}

		for (const fileUri of pyFiles) {
			try{
				const buffer = await vscode.workspace.fs.readFile(fileUri);
				const code = new TextDecoder('utf-8').decode(buffer);//读取py文件的内容
				const pyastPath = path.join(context.extensionPath, 'pyast_nor.py');
				const stdout = await new Promise<string>((resolve, reject) => {
					const proc = spawn('python3', [pyastPath]);
					let out = '';
					proc.stdout.on('data', (chunk) => { out += chunk.toString(); });
					proc.stderr.on('data', (chunk) => { reject(new Error(chunk.toString())); });
					proc.on('error', reject);
					proc.on('close', (exitCode) => {
						if (exitCode === 0) { resolve(out); }
						else { reject(new Error(`python3 exited with code ${exitCode}`)); }
					});
					proc.stdin.write(code, 'utf-8');
					proc.stdin.end();
				});//spawn 写入 stdin 后关闭，避免 execFile input 与 Python 读 stdin 死锁
				//console.log(`Normalized AST for file ${fileUri.fsPath} has been generated.`);//测试信息
				const py = JSON.parse(stdout.trim()) as { success: boolean; ast?: unknown; error?: string };//解析
				if (py.success) {
					//console.log(`Fingerprint for file ${fileUri.fsPath}:`, astFingerprint(py.ast));//测试信息
					const wfp = await sourceToWfp(fileUri.fsPath, code);//生成 Winnowing指纹
					//console.log(`WFP for ${fileUri.fsPath} has been generated.`);//测试信息
					const hits = await scanossCompare(fileUri.fsPath, wfp);//进行大量在线比对
					report.push(buildScanossReport(fileUri.fsPath, hits));
				} else console.error(`Python normalize failed for ${fileUri.fsPath}:`, py.error);//测试信息
			}catch (error) {
				console.error(`Error parsing file ${fileUri.fsPath}:`, error);
			}//解析py文件时，如果发生错误则输出错误信息
		}
		const finalReport = report.join('\n\n');
		try {
			const cfg = vscode.workspace.getConfiguration('ipguard');//获取配置
			const result = await analyzeScanReport(finalReport, {
				model: cfg.get<string>('model', 'deepseek-chat')!,
				provider: 'deepseek',
				proxyBaseUrl: cfg.get<string>('proxyUrl', 'http://121.196.228.134:3004')!,
				temperature: 0.1,
				maxTokens: 4096,
			});//调用LLMservice，获取LLM的回馈
			output.clear();//清空内容
			output.appendLine(result.content);//写入llm的回馈
			output.show();//显示标签页
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			vscode.window.showErrorMessage(`IPguard: ${message}`);//错误信息
		}
   		//编辑区，调用llmservice.ts中的deliverScanReport函数，将SCANOSS报告传递给LLM服务
        // The code you place here will be executed every time your command is executed
        // Display a message box to the user
        vscode.window.showInformationMessage('calling IPguard');		

	});
	context.subscriptions.push(disposable);

}

// This method is called when your extension is deactivated
export function deactivate() {}
