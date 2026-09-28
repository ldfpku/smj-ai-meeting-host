import { ChatStreamReader } from "@/lib/model-output";
import { proxyFetch } from "@/lib/proxy-fetch";

/**
 * 公司的 AI 网关（Cloudflare Worker，OpenAI 格式）。仅服务端使用。
 *
 * 网关地址和密钥来自 AI_WORKER_URL / AI_WORKER_KEY。
 */

export class WorkerError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export interface WorkerRequest {
  model: string;
  system: string;
  input: string;
  maxTokens: number;
  timeoutMs: number;
  temperature?: number;
  /** 输出被截断时的说明 */
  truncatedMessage?: string;
}

function gateway(): { url: string; key: string } | undefined {
  const url = process.env.AI_WORKER_URL?.trim().replace(/\/+$/, "");
  const key = process.env.AI_WORKER_KEY?.trim();
  return url && key ? { url, key } : undefined;
}

export function isWorkerConfigured(): boolean {
  return !!gateway();
}

/** 返回模型输出的正文；失败时抛出 WorkerError */
export async function askWorker(request: WorkerRequest): Promise<string> {
  const target = gateway();
  if (!target) {
    throw new WorkerError("没有配置 AI_WORKER_URL 和 AI_WORKER_KEY。", 400);
  }

  const upstream = await proxyFetch(`${target.url}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${target.key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: request.model,
      messages: [
        { role: "system", content: request.system },
        { role: "user", content: request.input },
      ],
      // 网关上的模型默认会先长篇思考（实测 4 分钟），整理资料用不着
      reasoning_effort: "low",
      temperature: request.temperature ?? 0.2,
      max_tokens: request.maxTokens,
      // 流式：整理要十几秒到几十秒，不流式的连接会在中途被断开
      stream: true,
    }),
    signal: AbortSignal.timeout(request.timeoutMs),
  });

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => "");
    console.error(
      `AI worker (${request.model}) failed (${upstream.status}):`,
      detail.slice(0, 300)
    );
    throw new WorkerError(
      upstream.status === 401 || upstream.status === 403
        ? "密钥无效（AI_WORKER_KEY）。"
        : upstream.status === 404
        ? `网关上没有模型 ${request.model}。`
        : upstream.status === 429
        ? "请求过于频繁，请稍后再试。"
        : `请求失败（HTTP ${upstream.status}）。`,
      upstream.status
    );
  }

  const reader = new ChatStreamReader();
  const decoder = new TextDecoder();
  const body = upstream.body.getReader();
  for (;;) {
    const { done, value } = await body.read();
    if (done) break;
    reader.push(decoder.decode(value, { stream: true }));
  }
  reader.push(decoder.decode());
  reader.end();

  if (reader.finishReason === "length") {
    throw new WorkerError(
      request.truncatedMessage ?? "输出被截断，结果不完整。",
      502
    );
  }
  if (!reader.content.trim()) {
    throw new WorkerError("没有返回内容。", 502);
  }
  return reader.content;
}
