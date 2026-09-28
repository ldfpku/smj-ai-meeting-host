import { htmlToText } from "./html-to-text";

/**
 * 在浏览器里把会议文档读成文字（md、txt、docx）。
 *
 * 文件本身不上传：docx 在本机解开，只有读出来的文字会发给服务端整理。
 */

export const DOCUMENT_ACCEPT = ".md,.markdown,.txt,.docx";
const MAX_FILE_BYTES = 10 * 1024 * 1024;

export class DocumentError extends Error {}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
}

/** 国内不少 txt、md 是 GBK 编码：按 UTF-8 读不通时改用 GB18030 */
function decodeText(bytes: ArrayBuffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("gb18030").decode(bytes);
  }
}

async function readDocx(bytes: ArrayBuffer): Promise<string> {
  const loaded: any = await import("mammoth/mammoth.browser.min.js");
  const mammoth = loaded.convertToHtml ? loaded : loaded.default;
  let html: string;
  try {
    const result = await mammoth.convertToHtml(
      { arrayBuffer: bytes },
      // 图片对读议程没有用，转成 HTML 会占很大篇幅
      { convertImage: mammoth.images.imgElement(async () => ({ src: "" })) }
    );
    html = result.value;
  } catch (err) {
    console.warn("[import] could not read the docx file", err);
    throw new DocumentError(
      "这个 docx 文件打不开。请确认它是 Word 文档（不是改了扩展名的其他文件），且没有设置打开密码。"
    );
  }
  return htmlToText(html);
}

export async function readDocumentFile(file: File): Promise<string> {
  if (file.size > MAX_FILE_BYTES) {
    throw new DocumentError("文件超过 10 MB。请只保留会议通知和议程部分。");
  }
  const extension = extensionOf(file.name);
  if (extension === "doc") {
    throw new DocumentError(
      "不支持旧版 .doc 文件。请在 Word 里另存为 .docx 后再导入。"
    );
  }
  if (!["md", "markdown", "txt", "docx"].includes(extension)) {
    throw new DocumentError("只支持 md、txt 和 docx 文件。");
  }

  const bytes = await file.arrayBuffer();
  const text =
    extension === "docx" ? await readDocx(bytes) : decodeText(bytes);
  if (!text.trim()) {
    throw new DocumentError(
      "文件里没有读到文字。内容如果是图片或图形，请改为粘贴文字。"
    );
  }
  return text;
}
