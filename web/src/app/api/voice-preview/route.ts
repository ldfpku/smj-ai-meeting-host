import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { VOICE_PREVIEW_TEXT } from "@/data/voice-preview";

/**
 * 音色试听：用 Gemini TTS 合成一段固定示例语音，让用户听过再选，而不是盲选。
 *
 * 走服务端代理而不是浏览器直连 Google，原因有二：
 *  1. 避开跨域不确定性；
 *  2. 与既有做法一致——浏览器本来就把 Gemini 密钥 POST 给 /api/token。
 * 密钥只在本次请求中透传给 Google，不落盘、不记录。
 *
 * 接口契约见 https://ai.google.dev/gemini-api/docs/speech-generation
 * 返回的是 24kHz / 16bit / 单声道的裸 PCM，需要自己补 WAV 头浏览器才能播。
 */

const TTS_MODEL = "gemini-3.1-flash-tts-preview";
const TTS_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/interactions";
const DEFAULT_SAMPLE_RATE = 24000;

/** 在返回的 JSON 里找到 base64 音频，容忍字段命名差异 */
function extractAudio(json: any): { data?: string; mime?: string } {
  const outputAudio = json?.output_audio ?? json?.outputAudio;
  if (outputAudio?.data) {
    return {
      data: outputAudio.data,
      mime: outputAudio.mime_type ?? outputAudio.mimeType,
    };
  }
  // 兼容 generateContent 形态的返回
  const parts = json?.candidates?.[0]?.content?.parts ?? [];
  for (const part of parts) {
    const inline = part?.inlineData ?? part?.inline_data;
    if (inline?.data) {
      return { data: inline.data, mime: inline.mimeType ?? inline.mime_type };
    }
  }
  return {};
}

function sampleRateFromMime(mime: string | undefined): number {
  if (!mime) return DEFAULT_SAMPLE_RATE;
  const m = /rate=(\d+)/i.exec(mime);
  return m ? parseInt(m[1], 10) : DEFAULT_SAMPLE_RATE;
}

/**
 * 磁盘缓存：示例文本固定，因此每个音色全局只需真正合成一次。
 * 换浏览器、清缓存、重启服务都不会重复调用 API。
 */
const CACHE_DIR = path.join(process.cwd(), ".cache", "voice-previews");

function cacheFileFor(voice: string, text: string): string {
  const textHash = createHash("sha1").update(text).digest("hex").slice(0, 8);
  const safeVoice = voice.replace(/[^A-Za-z0-9_-]/g, "");
  return path.join(CACHE_DIR, `${safeVoice}-${textHash}.wav`);
}

async function readCache(file: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(file);
  } catch {
    return null;
  }
}

async function writeCache(file: string, data: Buffer): Promise<void> {
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, data);
  } catch (err) {
    // 只读文件系统（如部分托管环境）下缓存不可用，退化为每次合成，不影响功能
    console.warn("Voice preview cache write skipped:", err);
  }
}

function wavResponse(wav: Buffer, cacheHit: boolean): Response {
  return new Response(new Uint8Array(wav), {
    status: 200,
    headers: {
      "Content-Type": "audio/wav",
      "Content-Length": String(wav.length),
      "Cache-Control": "no-store",
      "X-Voice-Preview-Cache": cacheHit ? "hit" : "miss",
    },
  });
}

/** 给裸 PCM 套上 44 字节 WAV 头 */
function pcmToWav(pcm: Buffer, sampleRate: number): Buffer {
  const channels = 1;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;

  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // audio format = PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([header, pcm]);
}

export async function POST(request: Request) {
  let body: { apiKey?: string; voice?: string; text?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }

  const { apiKey, voice } = body;
  const text = body.text?.trim() || VOICE_PREVIEW_TEXT;

  if (!voice) {
    return Response.json({ error: "缺少音色名称" }, { status: 400 });
  }

  // 先查磁盘缓存：命中就不需要密钥，也不产生任何 API 调用
  const cacheFile = cacheFileFor(voice, text);
  const cached = await readCache(cacheFile);
  if (cached) {
    return wavResponse(cached, true);
  }

  // 走到这里说明缓存没命中，必须真的合成一次，此时才需要密钥
  if (!apiKey) {
    return Response.json(
      {
        error: "该音色尚未生成过示例，首次试听需要 Gemini API 密钥。",
        code: "MISSING_API_KEY",
      },
      { status: 400 }
    );
  }

  let upstream: Response;
  try {
    upstream = await fetch(TTS_ENDPOINT, {
      method: "POST",
      headers: {
        "x-goog-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: TTS_MODEL,
        input: text,
        response_format: { type: "audio" },
        generation_config: { speech_config: [{ voice }] },
      }),
    });
  } catch (err) {
    console.error("Voice preview upstream request failed:", err);
    return Response.json(
      { error: "无法连接到 Gemini 语音合成服务，请检查网络。" },
      { status: 502 }
    );
  }

  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => "");
    console.error(`Voice preview failed (${upstream.status}):`, detail.slice(0, 500));
    const message =
      upstream.status === 400 || upstream.status === 403
        ? "Gemini API 密钥无效或无权访问语音合成模型。"
        : upstream.status === 429
        ? "语音合成请求过于频繁，请稍后再试。"
        : `语音合成失败（HTTP ${upstream.status}）。`;
    return Response.json({ error: message }, { status: upstream.status });
  }

  const json = await upstream.json().catch(() => null);
  const { data, mime } = extractAudio(json);

  if (!data) {
    console.error(
      "Voice preview: no audio in response:",
      JSON.stringify(json).slice(0, 500)
    );
    return Response.json(
      { error: "语音合成服务没有返回音频数据。" },
      { status: 502 }
    );
  }

  const wav = pcmToWav(Buffer.from(data, "base64"), sampleRateFromMime(mime));
  await writeCache(cacheFile, wav);

  return wavResponse(wav, false);
}
