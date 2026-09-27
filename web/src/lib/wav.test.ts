// Run with: node --test web/src/lib/wav.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { ensureWav, isWav, pcmToWav } from "./wav.ts";

const pcm = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

test("raw PCM is not mistaken for a WAV file", () => {
  assert.equal(isWav(pcm), false);
  assert.equal(isWav(new Uint8Array(0)), false);
});

test("pcmToWav writes a valid 44-byte header", () => {
  const wav = pcmToWav(pcm, 24000, 1);
  const view = new DataView(wav.buffer);

  assert.equal(wav.length, 44 + pcm.length);
  assert.equal(isWav(wav), true);
  assert.equal(view.getUint32(4, true), 36 + pcm.length);
  assert.equal(view.getUint16(20, true), 1); // PCM
  assert.equal(view.getUint16(22, true), 1); // channels
  assert.equal(view.getUint32(24, true), 24000); // sample rate
  assert.equal(view.getUint32(28, true), 48000); // byte rate
  assert.equal(view.getUint16(34, true), 16); // bits per sample
  assert.equal(view.getUint32(40, true), pcm.length);
  assert.deepEqual(Array.from(wav.slice(44)), Array.from(pcm));
});

test("ensureWav wraps raw PCM", () => {
  const wav = ensureWav(pcm, 24000, 1);
  assert.equal(wav.length, 44 + pcm.length);
  assert.equal(isWav(wav), true);
});

test("ensureWav leaves a WAV file untouched", () => {
  const wav = pcmToWav(pcm, 24000, 1);
  const again = ensureWav(wav, 24000, 1);
  assert.equal(again, wav);
  assert.equal(again.length, 44 + pcm.length);
});
