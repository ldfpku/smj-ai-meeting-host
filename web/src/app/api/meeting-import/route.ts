import path from "node:path";
import dotenv from "dotenv";
import { SMJ_DEPARTMENTS, SMJ_PROCESSES, SMJ_ROLES } from "@/data/smj-org";
import { modelsToTry } from "@/lib/ai-models";
import { askWorker, isWorkerConfigured, WorkerError } from "@/lib/ai-worker";
import {
  buildImportInput,
  buildImportInstruction,
  ImportError,
  ImportVocabulary,
  normalizeImport,
  prepareDocumentText,
} from "@/lib/meeting-import";
import { parseJsonObject } from "@/lib/model-output";

// 密钥放在仓库根目录的 .env.local（与 /api/token 一致），Next 默认只读 web/.env.local
dotenv.config({ path: path.join(process.cwd(), "../.env.local") });

/**
 * 会议文档导入：把会议通知、议程这类文档整理成标准会议配置。
 *
 * 文档在浏览器里读成文字后发到这里，由 Cloudflare Workers AI（经 Worker 的 env.AI
 * 绑定，见 lib/ai-worker.ts）上的模型阅读，再由 normalizeImport 对照公司的部门、岗位、
 * 流程清单校验。只用这一条路，不用其他厂商的模型：会议文档不发到 Cloudflare 以外的地方。
 *
 * 模型：2026-09-28 用两份样例文档比较了三个模型，三个都读得对，
 * 也都没有执行文档里夹带的指令。glm-5.3-flash 最快（8–16 秒），
 * deepseek-v4-flash-0731 次之（12–28 秒）但偶尔自己补写议题目标，
 * qwen3.8-27b 最慢（27–40 秒）。AI_WORKER_IMPORT_MODEL 可以改用别的模型。
 */
const MODEL = process.env.AI_WORKER_IMPORT_MODEL?.trim();
const TIMEOUT_MS = 90_000;

/** 本接口使用服务端密钥；上限防止有人拿它当通用的模型入口 */
const MAX_REQUEST_CHARS = 400_000;

const VOCABULARY: ImportVocabulary = {
  departments: SMJ_DEPARTMENTS.map((d) => d.name),
  roles: SMJ_ROLES,
  processes: SMJ_PROCESSES.map((p) => ({ id: p.id, name: p.name })),
};

interface ImportRequest {
  text?: string;
  fileName?: string;
}

export async function POST(request: Request) {
  let body: ImportRequest;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }

  const raw = typeof body.text === "string" ? body.text : "";
  if (raw.length > MAX_REQUEST_CHARS) {
    return Response.json(
      { error: "文档太长。请只保留会议通知和议程部分。" },
      { status: 413 }
    );
  }
  const { text, truncated } = prepareDocumentText(raw);
  if (text.length < 10) {
    return Response.json(
      { error: "文档里没有可以整理的内容。", code: "EMPTY_DOCUMENT" },
      { status: 400 }
    );
  }

  if (!isWorkerConfigured()) {
    return Response.json(
      {
        error:
          "服务端没有可用的 Cloudflare AI 绑定：检查 wrangler.jsonc 的 ai 配置；本地开发需要登录 ZY 账号。",
        code: "MISSING_API_KEY",
      },
      { status: 400 }
    );
  }

  const fileName =
    typeof body.fileName === "string" ? body.fileName.slice(0, 200) : undefined;
  const system = buildImportInstruction(VOCABULARY);
  const input = buildImportInput(text, fileName);

  const models = modelsToTry(MODEL);
  const failures: { model: string; error: WorkerError }[] = [];

  for (const model of models) {
    try {
      const output = await askWorker({
        model,
        system,
        input,
        maxTokens: 8192,
        timeoutMs: TIMEOUT_MS,
        temperature: 0.1,
        truncatedMessage: "输出被截断，议程不完整。",
      });

      let parsed: unknown;
      try {
        parsed = parseJsonObject(output);
      } catch {
        console.error(
          `Meeting import (${model}): output is not JSON. Head:`,
          output.slice(0, 200)
        );
        throw new WorkerError("AI 返回的内容无法解析。", 502);
      }

      const { meeting, warnings } = normalizeImport(parsed, VOCABULARY);
      if (truncated) {
        warnings.unshift(
          `文档较长，只读了前 ${text.length} 个字。后面的内容没有整理。`
        );
      }
      return Response.json({
        meeting,
        warnings,
        model,
        chars: text.length,
        fallbackFrom: failures.map((f) => ({
          model: f.model,
          error: f.error.message,
        })),
      });
    } catch (err) {
      if (err instanceof ImportError) {
        // 模型读完了，文档里确实没有议题：换一个模型也一样
        return Response.json(
          { error: err.message, code: "NO_AGENDA" },
          { status: 422 }
        );
      }
      const error =
        err instanceof WorkerError
          ? err
          : new WorkerError(
              err instanceof Error && err.name === "TimeoutError"
                ? "模型在 90 秒内没有整理完。"
                : "无法连接到模型服务，请检查网络。",
              502
            );
      if (!(err instanceof WorkerError)) {
        console.error(`Meeting import (${model}) request failed:`, err);
      }
      failures.push({ model, error });
      // 没有权限、请求太频繁：换模型没有用
      if ([400, 401, 403, 429].includes(error.status)) break;
    }
  }

  const last = failures[failures.length - 1];
  return Response.json(
    {
      error: failures.map((f) => `${f.model}：${f.error.message}`).join(" "),
    },
    { status: last.error.status }
  );
}
