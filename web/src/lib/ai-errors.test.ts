// Run with: node --test web/src/lib/ai-errors.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { describeAiError } from "./ai-errors.ts";

test("known failures get a plain message and a matching status", () => {
  assert.equal(describeAiError(new Error("429 Too Many Requests")).status, 429);
  assert.equal(
    describeAiError(new Error("AiError: 3040: Capacity temporarily exceeded")).status,
    429
  );
  assert.equal(describeAiError(new Error("No such model @cf/x/y")).status, 404);
  assert.equal(describeAiError(new Error("Authentication error 10000")).status, 403);
  const timeout = new Error("timeout");
  timeout.name = "TimeoutError";
  assert.equal(describeAiError(timeout).status, 504);
});

test("anything else is a 502 that does not leak the original text", () => {
  const out = describeAiError(new Error("internal error; reference = abc123"));
  assert.equal(out.status, 502);
  assert.ok(!out.message.includes("abc123"));
});
