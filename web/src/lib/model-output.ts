/**
 * 从模型输出里取出 JSON 对象。
 *
 * 不支持"按结构输出"的模型只能靠提示词要求返回 JSON，实际返回时常带着代码块
 * 标记，或在前后加一句说明。这里只取第一个 { 到最后一个 } 之间的内容。
 */
export function parseJsonObject(text: string): unknown {
  const trimmed = text.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new SyntaxError("no JSON object in the model output");
  }
  return JSON.parse(trimmed.slice(start, end + 1));
}

/**
 * 从 OpenAI 格式的流式响应（SSE）里拼出正文。
 *
 * 思考过程（reasoning_content）不算正文。数据块可能在任意位置被切开，
 * 所以按行缓冲：只处理已经收完整的行。
 */
export class ChatStreamReader {
  private buffer = "";
  content = "";
  finishReason: string | null = null;

  push(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline !== -1) {
      this.line(this.buffer.slice(0, newline).trim());
      this.buffer = this.buffer.slice(newline + 1);
      newline = this.buffer.indexOf("\n");
    }
  }

  end(): void {
    if (this.buffer.trim()) this.line(this.buffer.trim());
    this.buffer = "";
  }

  private line(line: string): void {
    if (!line.startsWith("data:")) return;
    const raw = line.slice(5).trim();
    if (!raw || raw === "[DONE]") return;
    let event: any;
    try {
      event = JSON.parse(raw);
    } catch {
      return;
    }
    for (const choice of Array.isArray(event?.choices) ? event.choices : []) {
      const piece = choice?.delta?.content;
      if (typeof piece === "string") this.content += piece;
      if (choice?.finish_reason) this.finishReason = choice.finish_reason;
    }
  }
}
