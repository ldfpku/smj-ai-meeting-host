// Run with: node --test web/src/lib/html-to-text.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { htmlToText } from "./html-to-text.ts";

test("headings, paragraphs and lists keep their structure", () => {
  const html =
    "<h1>专题会通知</h1><p>各部门：</p><p>定于 <strong>10 月 9 日</strong>召开。</p>" +
    "<h2>议程</h2><ol><li>瓶颈工序</li><li>交付优先级<ul><li>新疆客户</li></ul></li></ol>" +
    "<ul><li>列席：周敏</li></ul>";
  assert.equal(
    htmlToText(html),
    [
      "# 专题会通知",
      "",
      "各部门：",
      "",
      "定于 10 月 9 日召开。",
      "",
      "## 议程",
      "",
      "1. 瓶颈工序",
      "2. 交付优先级",
      "  - 新疆客户",
      "",
      "- 列席：周敏",
    ].join("\n")
  );
});

test("a table keeps its rows and columns", () => {
  const html =
    "<p>议程如下</p><table><tr><th><p>序号</p></th><th><p>议题</p></th><th><p>汇报人</p></th></tr>" +
    "<tr><td><p>1</p></td><td><p>瓶颈工序</p><p>含硫化罐</p></td><td><p>王强</p></td></tr>" +
    "<tr><td><p>2</p></td><td><p>A|B 方案</p></td><td></td></tr>" +
    "<tr><td></td><td></td><td></td></tr></table><p>请准时参会</p>";
  assert.equal(
    htmlToText(html),
    [
      "议程如下",
      "",
      "| 序号 | 议题 | 汇报人 |",
      "|---|---|---|",
      "| 1 | 瓶颈工序 含硫化罐 | 王强 |",
      "| 2 | A／B 方案 |  |",
      "",
      "请准时参会",
    ].join("\n")
  );
});

test("a table inside a cell becomes text of that cell", () => {
  const html =
    "<table><tr><td><p>参会</p></td><td><table><tr><td>王强</td><td>李明</td></tr></table></td></tr></table>";
  assert.equal(htmlToText(html), "| 参会 | 王强 李明 |\n|---|---|");
});

test("entities are decoded, pictures and line breaks handled", () => {
  const html =
    '<p>研发&amp;工艺 &lt;评审&gt;&nbsp;&#20250;&#x8BAE;</p><p><img src="data:image/png;base64,AAAA" />第一行<br />第二行</p>';
  assert.equal(htmlToText(html), "研发&工艺 <评审> 会议\n\n第一行\n第二行");
});

test("nothing in, nothing out", () => {
  assert.equal(htmlToText(""), "");
  assert.equal(htmlToText("<p></p><table></table>"), "");
});
