/**
 * 会议应用用到的文本模型：对外的短名 → Workers AI 目录里的模型 id。
 *
 * 全部走 Cloudflare 的 `env.AI` 绑定（见 ai-worker.ts），这里是唯一的清单。
 * 只允许清单里的模型，避免接口被用来调用任意模型。
 */
export const MODEL_CATALOG: Record<string, string> = {
  "glm-5.3-flash": "@cf/zai-org/glm-5.3-flash",
  "deepseek-v4-flash-0731": "@cf/deepseek-ai/deepseek-v4-flash-0731",
  "qwen3.8-27b": "@cf/qwen/qwen3.8-27b",
};

/** 默认模型（2026-09-28 的比较：三个都能完成任务，glm 最快） */
export const DEFAULT_MODEL = "glm-5.3-flash";

/** 一个模型失败时，按这个顺序换下一个 */
export const MODEL_FALLBACK_ORDER = [
  "glm-5.3-flash",
  "deepseek-v4-flash-0731",
  "qwen3.8-27b",
];

/** 从首选模型开始、按兜底顺序排出要尝试的模型 */
export function modelsToTry(preferred: string | undefined): string[] {
  const first = preferred && MODEL_CATALOG[preferred] ? preferred : DEFAULT_MODEL;
  return [first, ...MODEL_FALLBACK_ORDER.filter((m) => m !== first)];
}

export function catalogId(model: string): string | undefined {
  return MODEL_CATALOG[model];
}
