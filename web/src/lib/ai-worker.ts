import { getCloudflareContext } from "@opennextjs/cloudflare";
import { catalogId } from "@/lib/ai-models";
import { describeAiError } from "@/lib/ai-errors";
import { ChatStreamReader } from "@/lib/model-output";

/**
 * 文本模型调用：Cloudflare Workers AI，经 Worker 的 `env.AI` 绑定。仅服务端使用。
 *
 * 这是整个应用里调用文本模型的唯一入口（纪要、文档导入、以后的追问都走这里）。
 * 不需要密钥：绑定属于 wrangler.jsonc 所在的账号。可选的 AI_GATEWAY_ID
 * （wrangler.jsonc 的 vars）把请求交给该账号里的 AI Gateway；会议内容不缓存、不留日志。
 */

export class WorkerError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export interface WorkerRequest {
  /** ai-models.ts 里的短名，如 glm-5.3-flash */
  model: string;
  system: string;
  input: string;
  maxTokens: number;
  timeoutMs: number;
  temperature?: number;
  /** 输出被截断时的说明 */
  truncatedMessage?: string;
}

/** 只用到 run()；不依赖 workers-types，便于测试替换 */
interface AiBinding {
  run(model: string, input: unknown, options?: unknown): Promise<unknown>;
}

function context(): { ai: AiBinding; gatewayId: string } | undefined {
  try {
    const env = getCloudflareContext().env as unknown as Record<string, unknown>;
    const ai = env.AI as AiBinding | undefined;
    if (!ai || typeof ai.run !== "function") return undefined;
    const gatewayId =
      typeof env.AI_GATEWAY_ID === "string" ? env.AI_GATEWAY_ID.trim() : "";
    return { ai, gatewayId };
  } catch {
    // 不在 Cloudflare 运行环境里，也没有 initOpenNextCloudflareForDev
    return undefined;
  }
}

export function isWorkerConfigured(): boolean {
  return !!context();
}

/** 返回模型输出的正文；失败时抛出 WorkerError */
export async function askWorker(request: WorkerRequest): Promise<string> {
  const target = context();
  if (!target) {
    throw new WorkerError(
      "没有可用的 Cloudflare AI 绑定：检查 wrangler.jsonc 的 ai 配置；本地开发需要登录 ZY 账号。",
      400
    );
  }
  const modelId = catalogId(request.model);
  if (!modelId) {
    throw new WorkerError(`没有模型 ${request.model}。`, 404);
  }

  const params = {
    messages: [
      { role: "system", content: request.system },
      { role: "user", content: request.input },
    ],
    // 模型默认会先长篇思考（实测 4 分钟），整理资料用不着
    reasoning_effort: "low",
    temperature: request.temperature ?? 0.2,
    max_tokens: request.maxTokens,
    // 流式：整理要十几秒到几十秒，不流式的连接会在中途被断开
    stream: true,
  };
  const options = target.gatewayId
    ? {
        gateway: {
          id: target.gatewayId,
          skipCache: true,
          collectLog: false,
        },
      }
    : undefined;

  // 期限只建一个 Promise，读流时反复与它竞速（不会越积越多监听器）
  const timeout = abortAfter(AbortSignal.timeout(request.timeoutMs));
  timeout.catch(() => {}); // 没人在等时不要报“未处理的拒绝”
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const out = await Promise.race([
      target.ai.run(modelId, params, options),
      timeout,
    ]);
    if (!(out instanceof ReadableStream)) {
      throw new WorkerError("模型没有返回数据流。", 502);
    }
    reader = out.getReader() as ReadableStreamDefaultReader<Uint8Array>;

    const parser = new ChatStreamReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await Promise.race([
        reader.read(),
        timeout,
      ]);
      if (done) break;
      parser.push(decoder.decode(value, { stream: true }));
    }
    parser.push(decoder.decode());
    parser.end();

    if (parser.finishReason === "length") {
      throw new WorkerError(
        request.truncatedMessage ?? "输出被截断，结果不完整。",
        502
      );
    }
    if (!parser.content.trim()) {
      throw new WorkerError("没有返回内容。", 502);
    }
    return parser.content;
  } catch (err) {
    if (err instanceof WorkerError) throw err;
    console.error(`AI (${request.model}) failed:`, err);
    const { message, status } = describeAiError(err);
    throw new WorkerError(message, status);
  } finally {
    reader?.cancel().catch(() => {});
  }
}

/** 到点就以 TimeoutError 拒绝；用来给不接受 signal 的调用加期限 */
function abortAfter(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const fail = () =>
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new DOMException("timeout", "TimeoutError")
      );
    if (signal.aborted) fail();
    else signal.addEventListener("abort", fail, { once: true });
  });
}
