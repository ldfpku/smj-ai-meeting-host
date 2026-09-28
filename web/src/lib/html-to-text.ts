/**
 * 把 docx 转出来的 HTML 变成带结构的纯文本，交给模型阅读。
 *
 * 保留模型判断议程要用到的结构：标题（#）、列表（- 或 1.）、表格（| a | b |）。
 * 会议通知里的议程和参会人常常是表格，丢了行列关系就读不对。
 * 图片、字体、颜色都不保留。
 */

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === "#") {
      const point =
        code[1] === "x" || code[1] === "X"
          ? parseInt(code.slice(2), 16)
          : parseInt(code.slice(1), 10);
      return Number.isFinite(point) && point > 0 && point <= 0x10ffff
        ? String.fromCodePoint(point)
        : whole;
    }
    return ENTITIES[code.toLowerCase()] ?? whole;
  });
}

export function htmlToText(html: string): string {
  const lines: string[] = [];
  const lists: { ordered: boolean; count: number }[] = [];
  let line = "";
  // 表格：只认最外层的行列，嵌套表格的文字并入所在的单元格
  let tableDepth = 0;
  let rowsInTable = 0;
  let row: string[] | null = null;
  let cell: string | null = null;

  const write = (text: string) => {
    if (cell !== null) cell += text;
    else line += text;
  };
  const endLine = () => {
    if (cell !== null) {
      cell += " ";
      return;
    }
    if (line.trim()) lines.push(line.replace(/\s+$/, ""));
    line = "";
  };
  const blank = () => {
    if (cell === null && lines.length && lines[lines.length - 1] !== "") {
      lines.push("");
    }
  };

  const tokens = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>|([^<]+)/g;
  let match: RegExpExecArray | null;
  while ((match = tokens.exec(html)) !== null) {
    if (match[3] !== undefined) {
      write(decodeEntities(match[3]).replace(/\s+/g, " "));
      continue;
    }
    const closing = match[1] === "/";
    const tag = match[2].toLowerCase();

    if (/^h[1-6]$/.test(tag)) {
      endLine();
      if (!closing) {
        blank();
        write("#".repeat(parseInt(tag[1], 10)) + " ");
      } else {
        blank();
      }
    } else if (tag === "p" || tag === "div") {
      endLine();
      if (closing && lists.length === 0) blank();
    } else if (tag === "br") {
      endLine();
    } else if (tag === "ul" || tag === "ol") {
      endLine();
      if (closing) {
        lists.pop();
        if (lists.length === 0) blank();
      } else {
        lists.push({ ordered: tag === "ol", count: 0 });
      }
    } else if (tag === "li") {
      endLine();
      if (!closing && cell === null) {
        const list = lists[lists.length - 1];
        const indent = "  ".repeat(Math.max(0, lists.length - 1));
        if (list?.ordered) {
          list.count += 1;
          write(`${indent}${list.count}. `);
        } else {
          write(`${indent}- `);
        }
      }
    } else if (tag === "table") {
      if (closing) {
        tableDepth = Math.max(0, tableDepth - 1);
        if (tableDepth === 0) blank();
      } else {
        if (tableDepth === 0) {
          endLine();
          blank();
          rowsInTable = 0;
        }
        tableDepth += 1;
      }
    } else if (tag === "tr" && tableDepth === 1) {
      if (!closing) {
        row = [];
      } else if (row) {
        if (row.some((c) => c)) {
          lines.push(`| ${row.join(" | ")} |`);
          rowsInTable += 1;
          if (rowsInTable === 1) {
            lines.push(`|${row.map(() => "---").join("|")}|`);
          }
        }
        row = null;
      }
    } else if ((tag === "td" || tag === "th") && tableDepth === 1) {
      if (!closing) {
        cell = "";
      } else if (cell !== null) {
        row?.push(cell.replace(/\s+/g, " ").replace(/\|/g, "／").trim());
        cell = null;
      }
    } else if ((tag === "tr" || tag === "td" || tag === "th") && closing) {
      // 嵌套表格：单元格之间留一个空格
      write(" ");
    }
  }
  endLine();

  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
}
