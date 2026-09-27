/**
 * WAV helpers for the TTS route.
 *
 * Deliberately free of imports and path aliases so `node --test` can run the
 * accompanying test file directly.
 */

/** True when the buffer already is a WAV file (RIFF....WAVE). */
export function isWav(data: Uint8Array): boolean {
  if (data.length < 12) return false;
  const tag = (offset: number) =>
    String.fromCharCode(
      data[offset],
      data[offset + 1],
      data[offset + 2],
      data[offset + 3]
    );
  return tag(0) === "RIFF" && tag(8) === "WAVE";
}

/** 给裸 PCM（16 位小端）套上 44 字节 WAV 头 */
export function pcmToWav(
  pcm: Uint8Array,
  sampleRate: number,
  channels: number
): Uint8Array {
  const bitsPerSample = 16;
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;

  const wav = new Uint8Array(44 + pcm.length);
  const view = new DataView(wav.buffer);
  const writeTag = (offset: number, tag: string) => {
    for (let i = 0; i < 4; i++) wav[offset + i] = tag.charCodeAt(i);
  };

  writeTag(0, "RIFF");
  view.setUint32(4, 36 + pcm.length, true);
  writeTag(8, "WAVE");
  writeTag(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeTag(36, "data");
  view.setUint32(40, pcm.length, true);
  wav.set(pcm, 44);

  return wav;
}

/**
 * Whatever the TTS model returned, hand back a playable WAV file.
 *
 * gemini-3.8-flash-tts answers a normal request with a complete WAV file;
 * the older TTS models (and streaming) return headerless PCM. Wrapping a WAV
 * file in a second header plays the first header as a click and makes
 * players report the wrong duration.
 */
export function ensureWav(
  audio: Uint8Array,
  sampleRate: number,
  channels: number
): Uint8Array {
  return isWav(audio) ? audio : pcmToWav(audio, sampleRate, channels);
}
