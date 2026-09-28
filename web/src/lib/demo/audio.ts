/**
 * 演示会议的声音：把合成语音当作会议室的麦克风发进房间，并监听主持人的声音。
 *
 * 发言走一条 MediaStreamTrack（代替真实麦克风发布到房间），同时从扬声器放出来，
 * 看演示的人才听得到参会人在说什么。
 */

const LOUD = 0.02;
/** 音量低于阈值这么久，才算一句话说完 */
const QUIET_MS = 500;
/** 音量高于阈值这么久，才算开始说话 */
const ONSET_MS = 150;

export class SimAudio {
  readonly context: AudioContext;
  private readonly mic: MediaStreamAudioDestinationNode;
  private readonly speaker: GainNode;
  private source: AudioBufferSourceNode | null = null;
  private clips = new Map<string, AudioBuffer>();

  // 主持人的声音
  private analysers: { node: AnalyserNode; source: MediaStreamAudioSourceNode }[] = [];
  private poll: ReturnType<typeof setInterval> | null = null;
  private samples = new Float32Array(1024);
  private loudSince = 0;
  moderatorSpeaking = false;
  moderatorStartedAt = 0;
  moderatorLastLoud = 0;
  /** 主持人每出一次声，结束时报告一次：何时开始、持续多久 */
  onModeratorSpoke: ((startedAt: number, ms: number) => void) | null = null;

  constructor() {
    this.context = new AudioContext();
    this.mic = this.context.createMediaStreamDestination();
    this.speaker = this.context.createGain();
    this.speaker.gain.value = 0.9;
    this.speaker.connect(this.context.destination);
    // 麦克风一直开着：没人说话时发的是静音，和真实会议室一样
    const silence = this.context.createConstantSource();
    silence.offset.value = 0;
    silence.connect(this.mic);
    silence.start();
  }

  get track(): MediaStreamTrack {
    return this.mic.stream.getAudioTracks()[0];
  }

  async resume(): Promise<void> {
    if (this.context.state !== "running") await this.context.resume();
  }

  /** 合成一句台词。用的是音色试听接口，同一句话只合成一次。 */
  async load(voice: string, text: string): Promise<AudioBuffer> {
    const key = `${voice}|${text}`;
    const known = this.clips.get(key);
    if (known) return known;

    let lastError = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await fetch("/api/voice-preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ voice, text }),
      });
      if (response.ok) {
        const buffer = await this.context.decodeAudioData(
          await response.arrayBuffer()
        );
        this.clips.set(key, buffer);
        return buffer;
      }
      const detail = await response.json().catch(() => null);
      lastError = detail?.error || `HTTP ${response.status}`;
      if (response.status !== 429 && response.status < 500) break;
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
    throw new Error(`合成「${text.slice(0, 12)}…」失败：${lastError}`);
  }

  /** 播放一句话。返回的 done 在说完或被 stop() 打断时结束。 */
  play(buffer: AudioBuffer): { done: Promise<void>; seconds: number } {
    this.stop();
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.mic);
    source.connect(this.speaker);
    this.source = source;
    const done = new Promise<void>((resolve) => {
      source.onended = () => {
        if (this.source === source) this.source = null;
        resolve();
      };
    });
    source.start();
    return { done, seconds: buffer.duration };
  }

  get speaking(): boolean {
    return this.source !== null;
  }

  stop(): void {
    const source = this.source;
    this.source = null;
    if (!source) return;
    try {
      source.stop();
    } catch {
      // 已经播完
    }
  }

  // ---- 主持人的声音 ---------------------------------------------------------

  /** 主持人有两条音轨（实时模型、直接播放的打断语音），都要听 */
  listenTo(track: MediaStreamTrack): void {
    const source = this.context.createMediaStreamSource(new MediaStream([track]));
    const node = this.context.createAnalyser();
    node.fftSize = 1024;
    source.connect(node);
    this.analysers.push({ node, source });
    if (!this.poll) this.poll = setInterval(() => this.measure(), 50);
  }

  private measure(): void {
    let peak = 0;
    for (const { node } of this.analysers) {
      node.getFloatTimeDomainData(this.samples);
      let sum = 0;
      for (let i = 0; i < this.samples.length; i++) {
        sum += this.samples[i] * this.samples[i];
      }
      peak = Math.max(peak, Math.sqrt(sum / this.samples.length));
    }
    const now = performance.now();
    if (peak >= LOUD) {
      this.loudSince ||= now;
      // 一声咔哒不算说话：连续响了一小会儿才算
      if (!this.moderatorSpeaking && now - this.loudSince >= ONSET_MS) {
        this.moderatorSpeaking = true;
        this.moderatorStartedAt = this.loudSince;
      }
      if (this.moderatorSpeaking) this.moderatorLastLoud = now;
    } else {
      if (!this.moderatorSpeaking) this.loudSince = 0;
      if (
        this.moderatorSpeaking &&
        now - this.moderatorLastLoud > QUIET_MS
      ) {
        this.moderatorSpeaking = false;
        this.loudSince = 0;
        this.onModeratorSpoke?.(
          this.moderatorStartedAt,
          this.moderatorLastLoud - this.moderatorStartedAt
        );
      }
    }
  }

  close(): void {
    this.stop();
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
    for (const { node, source } of this.analysers) {
      source.disconnect();
      node.disconnect();
    }
    this.analysers = [];
    this.track.stop();
    this.context.close().catch(() => undefined);
  }
}
