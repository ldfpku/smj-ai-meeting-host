/**
 * 音色试听用的固定示例语句。
 *
 * 刻意选用主持人「强行叫停 + 拉回议题」的实际台词，而不是中性的问候语——
 * 用户要判断的是这个音色在真实会议里叫停跑题时够不够有权威感、听不听得清，
 * 用一句「你好，我是 AI 助手」是判断不出来的。
 *
 * 文本固定不变，因此每个音色只需合成一次即可长期复用（见 /api/voice-preview 的磁盘缓存）。
 */
export const VOICE_PREVIEW_TEXT =
  "打扰一下，请大家先暂停一下。我们当前的议题是上月完成率，核心目标是确认完成情况与偏差原因。刚才的讨论已经偏离本议题，请回到当前议题上来。";

/** 试听音频的会话内缓存：音色 -> object URL，避免同一次使用里重复请求 */
const previewCache = new Map<string, string>();

let currentAudio: HTMLAudioElement | null = null;

/** 停止正在播放的试听 */
export function stopVoicePreview() {
  if (currentAudio) {
    currentAudio.pause();
    currentAudio.currentTime = 0;
    currentAudio = null;
  }
}

export function isVoicePreviewCached(voice: string): boolean {
  return previewCache.has(voice);
}

/** 试听失败时带上机器可判别的原因，便于区分「缺密钥」与其它错误 */
export class VoicePreviewError extends Error {
  code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.name = "VoicePreviewError";
    this.code = code;
  }
}

/**
 * 试听指定音色。
 *
 * 密钥是可选的：服务端磁盘缓存里已有的音色不需要密钥就能播（也不产生任何 API 调用），
 * 只有从未合成过的音色才会因缺密钥而失败，并回传 MISSING_API_KEY 让调用方去引导填写。
 *
 * @returns 播放开始时 resolve；播放结束由 onEnded 回调通知
 */
export async function playVoicePreview(
  voice: string,
  apiKey: string | null | undefined,
  onEnded?: () => void
): Promise<void> {
  stopVoicePreview();

  let url = previewCache.get(voice);

  if (!url) {
    const res = await fetch("/api/voice-preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: apiKey || undefined, voice }),
    });

    if (!res.ok) {
      let message = `试听失败（HTTP ${res.status}）`;
      let code: string | undefined;
      try {
        const err = await res.json();
        if (err?.error) message = err.error;
        if (err?.code) code = err.code;
      } catch {
        /* 响应体不是 JSON，用默认文案 */
      }
      throw new VoicePreviewError(message, code);
    }

    const blob = await res.blob();
    url = URL.createObjectURL(blob);
    previewCache.set(voice, url);
  }

  const audio = new Audio(url);
  currentAudio = audio;
  audio.addEventListener("ended", () => {
    if (currentAudio === audio) currentAudio = null;
    onEnded?.();
  });
  audio.addEventListener("error", () => {
    if (currentAudio === audio) currentAudio = null;
    onEnded?.();
  });

  await audio.play();
}
