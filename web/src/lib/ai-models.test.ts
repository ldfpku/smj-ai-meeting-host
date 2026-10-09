// Run with: node --test web/src/lib/ai-models.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { catalogId, DEFAULT_MODEL, MODEL_CATALOG, modelsToTry } from "./ai-models.ts";

test("every model of the catalog is a Workers AI id", () => {
  for (const id of Object.values(MODEL_CATALOG)) {
    assert.match(id, /^@cf\/[\w.-]+\/[\w.-]+$/);
  }
  assert.equal(catalogId("glm-5.3-flash"), "@cf/zai-org/glm-5.3-flash");
  assert.equal(catalogId("gpt-5"), undefined);
});

test("the preferred model goes first and each model is tried once", () => {
  assert.deepEqual(modelsToTry("qwen3.8-27b"), [
    "qwen3.8-27b",
    "glm-5.3-flash",
    "deepseek-v4-flash-0731",
  ]);
  const unknown = modelsToTry("no-such-model");
  assert.equal(unknown[0], DEFAULT_MODEL);
  assert.equal(new Set(unknown).size, unknown.length);
  assert.equal(modelsToTry(undefined)[0], DEFAULT_MODEL);
});
