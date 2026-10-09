/**
 * `env.AI.run()` 抛出的错误 → 给用户看的话和 HTTP 状态。
 *
 * Workers AI 的错误没有统一的类型，只能看消息和 code；认不出来的按 502 处理，
 * 细节只写进日志，不回给浏览器。
 */
export interface DescribedError {
  message: string;
  status: number;
}

export function describeAiError(err: unknown): DescribedError {
  const text =
    err instanceof Error ? `${err.name} ${err.message}` : String(err ?? "");
  const code = (err as { code?: unknown } | null)?.code;

  if (err instanceof Error && err.name === "TimeoutError") {
    return { message: "模型没有在规定时间内返回。", status: 504 };
  }
  if (
    code === 429 ||
    /\b429\b|rate.?limit|too many requests|capacity|3040/i.test(text)
  ) {
    return { message: "请求过于频繁，请稍后再试。", status: 429 };
  }
  if (/no such model|model not found|\b5007\b|unknown model/i.test(text)) {
    return { message: "没有这个模型。", status: 404 };
  }
  if (/authentication|unauthorized|forbidden|\b(401|403)\b|10000/i.test(text)) {
    return {
      message: "没有调用模型的权限（检查 Worker 的 AI 绑定与账号）。",
      status: 403,
    };
  }
  return { message: "模型调用失败。", status: 502 };
}
