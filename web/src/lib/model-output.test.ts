// Run with: node --test web/src/lib/model-output.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { ChatStreamReader, parseJsonObject } from "./model-output.ts";

test("a JSON object is found inside a code block and between remarks", () => {
  assert.deepEqual(parseJsonObject('```json\n{"a": 1}\n```'), { a: 1 });
  assert.deepEqual(parseJsonObject('好的，结果如下：{"a": {"b": "}"}} 以上。'), {
    a: { b: "}" },
  });
});

test("output without an object, or a truncated one, is an error", () => {
  assert.throws(() => parseJsonObject("抱歉，无法整理。"));
  assert.throws(() => parseJsonObject('{"a": [1, 2'));
});

test("the text of a streamed answer is put together, the reasoning left out", () => {
  const reader = new ChatStreamReader();
  const events = [
    { choices: [{ delta: { reasoning_content: "先想一想" } }] },
    { choices: [{ delta: { content: '{"a":' } }] },
    { choices: [{ delta: { content: " 1}" }, finish_reason: "stop" }] },
    { choices: [], usage: { total_tokens: 3 } },
  ];
  const stream =
    events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") +
    "data: [DONE]\n\n";

  // cut at awkward places, as the network does
  for (let i = 0; i < stream.length; i += 7) reader.push(stream.slice(i, i + 7));
  reader.end();

  assert.equal(reader.content, '{"a": 1}');
  assert.equal(reader.finishReason, "stop");
});
