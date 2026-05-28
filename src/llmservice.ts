export function buildReportforllm(finalReport: string, sourceCode?: string): string {
	if (!finalReport.trim()) {
		return 'No similar code found.';
	}
	return [
		'## SCANOSS report',
		finalReport,
		'',
		'## User source code',
		'```',
		sourceCode?.trim() ? sourceCode : '(not provided — refer to file paths in the SCANOSS report)',
		'```',
		'',
		'## Task',
		'Based on the SCANOSS report and source code, explain open-source license risks for commercial use and give concrete remediation steps.',
	].join('\n');
}

export interface ChatCompletionOptions {
	model: string;
	sourceCode?: string;
	temperature?: number;
	maxTokens?: number;
}//发送给connector.js的字段格式

export type ChatCompletionRequest = {
	model: string;
	messages: Array<{ role: 'user'; content: string }>;
	temperature: number;
	max_tokens: number;
};//最终发给LLM的JSON格式

export interface ChatCompletionResponse {
	content: string;           // LLM 分析结果（给用户展示）
	raw: unknown;              // 完整响应，便于调试
	usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  }//LLM响应格式

export function buildChatCompletionPayload(
	finalReport: string,
	options: ChatCompletionOptions
): ChatCompletionRequest {
	const userContent = buildReportforllm(finalReport, options.sourceCode);
	return {
		model: options.model,
		messages: [{ role: 'user', content: userContent }],
		temperature: options.temperature ?? 0.1,
		max_tokens: options.maxTokens ?? 4096,
	};//构建发送给LLM的JSON格式
}//拼凑发给LLM的格式信息


export function serializeChatCompletionPayload(payload: ChatCompletionRequest): string {
	return JSON.stringify(payload);
}//将发送给LLM的JSON格式字符串化，准备发送

export async function analyzeScanReport(
	finalReport: string,//SCANOSS报告
	config: LLMConfig,//LLM配置
	sourceCode?: string//源代码
): Promise<ChatCompletionResponse> {
	const payload = buildChatCompletionPayload(finalReport, {
		model: config.model,
		sourceCode,
		temperature: config.temperature,
		maxTokens: config.maxTokens,
	});//确定HTTP请求体和LLMConfig
	return fetchChatCompletion(payload, config);//发送请求，返回响应
}//将LLM的返回信息返还给extension.ts

export interface LLMConfig {
	model: string;
	provider: string;
	proxyBaseUrl: string;
	temperature: number;
	maxTokens: number;
}

export async function fetchChatCompletion(
	payload: ChatCompletionRequest,
	llmConfig: LLMConfig
): Promise<ChatCompletionResponse> {
	const url = `${llmConfig.proxyBaseUrl.replace(/\/$/, '')}/v1/chat/completions`;//确定url
	const controller = new AbortController();//设置取消控制器
	const timeout = setTimeout(() => controller.abort(), 120000);//设置超时
	const response = await globalThis.fetch(url, {//发送请求，globalthis是用来访问全局fetch的
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(payload),//发送请求体
		signal: controller.signal,
	});
	clearTimeout(timeout);//清除超时
	const raw = await response.json();//获取响应体，raw是还没有经过处理的原始JSON
	const content = (raw as { choices?: Array<{ message?: { content?: string } }> })
		.choices?.[0]?.message?.content ?? '';//规范raw
	return {
		content,
		raw,
		usage: (raw as { usage?: ChatCompletionResponse['usage'] }).usage,
	};
}//fetch函数，用来发送HTTP请求，连接提示词发送至云服务器，并且规范化大模型的返还JSON
