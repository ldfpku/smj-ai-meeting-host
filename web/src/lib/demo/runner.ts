import {
  Participant,
  RemoteParticipant,
  RemoteTrack,
  Room,
  RoomEvent,
  Track,
  TranscriptionSegment,
} from "livekit-client";
import {
  DEMO_ANSWERS,
  DEMO_CONFIG,
  DEMO_DEFAULT_ANSWER,
  DEMO_STEPS,
  DEMO_VOICES,
  DemoStep,
} from "@/data/demo-meeting";
import { SimAudio } from "./audio";

export interface DemoEvent {
  /** 会议开始后的秒数 */
  t: number;
  kind: string;
  text: string;
}

export interface DemoFinding {
  name: string;
  /** null：无法判断 */
  ok: boolean | null;
  detail: string;
}

export interface DemoLine {
  stepId: string;
  speaker: string;
  text: string;
  watch: string;
}

export interface DemoCallbacks {
  onEvent: (event: DemoEvent) => void;
  onLine: (line: DemoLine | null) => void;
}

interface StepRecord {
  id: string;
  expect?: string;
  start: number;
  speechEnd: number;
  end: number;
  yieldedAt: number | null;
  retried: boolean;
  skipped: boolean;
  /** 发言期间主持人开口的时刻 */
  moderatorSpokeAt: number | null;
}

class Stopped extends Error {}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 把一场演示会议从头开到尾，并记下主持人的每个反应。 */
export class DemoRunner {
  private readonly t0 = performance.now();
  private stopped = false;
  private agentState = "";
  private agendaIndex = 0;
  private answered = 0;
  private rollCalls: { name: string; t: number }[] = [];
  private decisions = new Map<string, { data: any; t: number }[]>();
  private openItems: { data: any; t: number }[] = [];
  private driftWarnings: { t: number; data: any }[] = [];
  private transcript = new Map<
    string,
    { role: "moderator" | "room"; text: string; t: number }
  >();
  private steps: StepRecord[] = [];
  private advancedAt: number | null = null;
  private ended = false;
  private cleanup: (() => void)[] = [];
  readonly events: DemoEvent[] = [];

  constructor(
    private readonly room: Room,
    private readonly audio: SimAudio,
    private readonly agent: RemoteParticipant,
    private readonly callbacks: DemoCallbacks
  ) {}

  // ---- 记录 -------------------------------------------------------------------

  private now(): number {
    return Math.round((performance.now() - this.t0) / 100) / 10;
  }

  private log(kind: string, text: string): void {
    const event = { t: this.now(), kind, text };
    this.events.push(event);
    console.log(`[demo ${event.t.toFixed(1).padStart(6)}] ${kind}: ${text}`);
    this.callbacks.onEvent(event);
  }

  private listen(): void {
    const room = this.room;

    const onData = (
      payload: Uint8Array,
      _participant?: Participant,
      _kind?: unknown,
      topic?: string
    ) => {
      if (topic !== "meeting_update") return;
      let data: any;
      try {
        data = JSON.parse(new TextDecoder().decode(payload));
      } catch {
        return;
      }
      this.onUpdate(data);
    };

    const onTranscription = (
      segments: TranscriptionSegment[],
      participant?: Participant
    ) => {
      for (const segment of segments) {
        const known = this.transcript.get(segment.id);
        const role = participant?.isAgent ? "moderator" : "room";
        const text = segment.text.trim();
        this.transcript.set(segment.id, {
          role,
          text,
          t: known ? known.t : this.now(),
        });
        if (segment.final && text && role === "moderator") {
          this.log("主持人", text);
        }
      }
    };

    const onAttributes = (
      changed: Record<string, string>,
      participant: Participant
    ) => {
      if (participant.identity !== this.agent.identity) return;
      if ("lk.agent.state" in changed) {
        this.agentState = changed["lk.agent.state"];
      }
    };

    const onTrack = (track: RemoteTrack, _pub: unknown, participant: Participant) => {
      if (participant.identity !== this.agent.identity) return;
      if (track.kind === Track.Kind.Audio) {
        this.audio.listenTo(track.mediaStreamTrack);
      }
    };

    room.on(RoomEvent.DataReceived, onData);
    room.on(RoomEvent.TranscriptionReceived, onTranscription);
    room.on(RoomEvent.ParticipantAttributesChanged, onAttributes);
    room.on(RoomEvent.TrackSubscribed, onTrack);
    this.cleanup.push(() => {
      room.off(RoomEvent.DataReceived, onData);
      room.off(RoomEvent.TranscriptionReceived, onTranscription);
      room.off(RoomEvent.ParticipantAttributesChanged, onAttributes);
      room.off(RoomEvent.TrackSubscribed, onTrack);
    });

    this.audio.onModeratorSpoke = (startedAt, ms) => {
      const at = Math.round((startedAt - this.t0) / 100) / 10;
      this.log("主持人出声", `${at.toFixed(1)} 秒起，持续 ${(ms / 1000).toFixed(1)} 秒`);
    };
    this.cleanup.push(() => (this.audio.onModeratorSpoke = null));

    this.agentState = this.agent.attributes?.["lk.agent.state"] ?? "";
    for (const publication of this.agent.audioTrackPublications.values()) {
      const track = publication.track;
      if (track) this.audio.listenTo(track.mediaStreamTrack);
    }
  }

  private onUpdate(data: any): void {
    switch (data.type) {
      case "state_sync":
      case "drift_score":
      case "intervention_metrics":
      case "intervention_settings":
        return;
      case "roll_call":
        this.rollCalls.push({ name: data.attendeeName ?? "", t: this.now() });
        this.log("点名", data.attendeeName ?? "");
        return;
      case "advance_agenda":
        this.agendaIndex = data.currentAgendaIndex ?? this.agendaIndex;
        this.advancedAt ??= this.now();
        this.log("推进议题", `进入第 ${this.agendaIndex + 1} 项`);
        return;
      case "new_decision": {
        const d = data.decision ?? {};
        const versions = this.decisions.get(d.id) ?? [];
        versions.push({ data: d, t: this.now() });
        this.decisions.set(d.id, versions);
        this.log(
          "记录决议",
          `${d.decision}｜责任人：${d.owner || "缺"}｜时限：${d.dueDate || "缺"}｜验证：${
            d.verification || "缺"
          }｜证据：${d.evidence || "缺"}`
        );
        return;
      }
      case "new_open_item": {
        const o = data.openItem ?? {};
        this.openItems = this.openItems.filter((x) => x.data.id !== o.id);
        this.openItems.push({ data: o, t: this.now() });
        this.log("登记未决事项", `${o.issue}｜跟进人：${o.owner || "缺"}`);
        return;
      }
      case "drift_warning":
        if (data.active === false) return;
        this.driftWarnings.push({ t: this.now(), data });
        this.log(
          "跑题提示",
          `${data.reason ?? ""}（${data.source ?? ""}${
            typeof data.confidence === "number"
              ? `，${Math.round(data.confidence * 100)}%`
              : ""
          }）`
        );
        return;
      case "meeting_summary":
        this.log("会议总结", data.text ?? "");
        return;
      case "meeting_ended":
        this.ended = true;
        this.log("会议结束", data.message ?? "");
        return;
      default:
        this.log("消息", data.type);
    }
  }

  // ---- 发言与等待 ---------------------------------------------------------------

  private check(): void {
    if (this.stopped) throw new Stopped();
    if (this.room.state !== "connected") {
      throw new Error("与会议的连接已断开");
    }
  }

  private moderatorBusy(settleMs: number): boolean {
    return (
      this.audio.moderatorSpeaking ||
      performance.now() - this.audio.moderatorLastLoud < settleMs ||
      this.agentState === "thinking" ||
      this.agentState === "speaking"
    );
  }

  /** 把发言权交给主持人，等它把要说的话说完 */
  private async waitReply(minMs = 4000, maxMs = 45000): Promise<void> {
    const started = performance.now();
    while (performance.now() - started < maxMs) {
      await sleep(100);
      this.check();
      if (
        performance.now() - started >= minMs &&
        !this.moderatorBusy(2000)
      ) {
        return;
      }
    }
    this.log("等待超时", `主持人状态：${this.agentState}`);
  }

  private async say(
    speaker: string,
    text: string,
    stepId: string,
    watch: string,
    record?: StepRecord
  ): Promise<number | null> {
    this.check();
    const buffer = await this.audio.load(DEMO_VOICES[speaker], text);
    this.check();
    this.callbacks.onLine({ stepId, speaker, text, watch });
    this.log(speaker, text);
    const startedAt = performance.now();
    const { done } = this.audio.play(buffer);
    let finished = false;
    done.then(() => (finished = true));

    let yieldedAt: number | null = null;
    while (!finished) {
      await sleep(50);
      if (this.stopped) {
        this.audio.stop();
        throw new Stopped();
      }
      const moderatorTalks =
        this.audio.moderatorSpeaking &&
        this.audio.moderatorStartedAt > startedAt &&
        performance.now() - this.audio.moderatorStartedAt > 1000;
      if (!moderatorTalks) continue;
      if (record && record.moderatorSpokeAt === null) {
        record.moderatorSpokeAt = this.now();
      }
      // 被主持人打断的人会停下来
      if (record?.expect === "interrupt") {
        yieldedAt = this.now();
        this.audio.stop();
        this.log("发言人停下", `${speaker}被打断后停止发言`);
        break;
      }
    }
    await done;
    this.callbacks.onLine(null);
    return yieldedAt;
  }

  private async answerRollCalls(): Promise<void> {
    for (let round = 0; round < 4; round++) {
      const waiting = this.rollCalls.slice(this.answered);
      if (waiting.length === 0) return;
      this.answered = this.rollCalls.length;
      // 看板先亮，主持人的问题后到
      await this.waitReply(2000);
      const agenda = DEMO_CONFIG.agendas[this.agendaIndex]?.id ?? "";
      for (const call of waiting) {
        if (!DEMO_VOICES[call.name]) continue;
        const text = DEMO_ANSWERS[agenda]?.[call.name] ?? DEMO_DEFAULT_ANSWER;
        await this.say(call.name, text, `answer:${agenda}`, "被点名后表态");
        await sleep(600);
      }
      await this.waitReply();
    }
  }

  private async floorToModerator(): Promise<void> {
    await this.waitReply();
    await this.answerRollCalls();
  }

  // ---- 全流程 -------------------------------------------------------------------

  /** 开会前把所有台词合成好，会中不必等 */
  static async prepare(
    audio: SimAudio,
    onProgress: (done: number, total: number) => void
  ): Promise<void> {
    const lines: [string, string][] = [];
    const add = (speaker: string, text: string) => {
      if (!lines.some(([s, t]) => s === speaker && t === text)) {
        lines.push([speaker, text]);
      }
    };
    for (const step of DEMO_STEPS) {
      add(step.say, step.text);
      if (step.retry) add(step.say, step.retry);
    }
    for (const answers of Object.values(DEMO_ANSWERS)) {
      for (const [speaker, text] of Object.entries(answers)) add(speaker, text);
    }
    for (const speaker of Object.keys(DEMO_VOICES)) {
      add(speaker, DEMO_DEFAULT_ANSWER);
    }

    let done = 0;
    onProgress(0, lines.length);
    const queue = [...lines];
    const worker = async () => {
      for (;;) {
        const line = queue.shift();
        if (!line) return;
        await audio.load(DEMO_VOICES[line[0]], line[1]);
        onProgress(++done, lines.length);
      }
    };
    await Promise.all([worker(), worker(), worker()]);
  }

  async run(): Promise<DemoFinding[]> {
    this.listen();
    try {
      await this.play();
    } catch (err) {
      if (!(err instanceof Stopped)) {
        this.log("演示中断", err instanceof Error ? err.message : String(err));
      }
    } finally {
      this.audio.stop();
      this.callbacks.onLine(null);
      for (const undo of this.cleanup) undo();
    }
    return this.analyse();
  }

  stop(): void {
    this.stopped = true;
  }

  private async play(): Promise<void> {
    this.log("开始", `演示会议「${DEMO_CONFIG.topic}」，等待主持人开场`);
    const started = performance.now();
    while (
      !this.audio.moderatorSpeaking &&
      performance.now() - started < 30000
    ) {
      await sleep(100);
      this.check();
    }
    await this.waitReply(2000, 60000);
    this.log("开场结束", "");

    for (const step of DEMO_STEPS) {
      const record: StepRecord = {
        id: step.id,
        expect: step.expect,
        start: this.now(),
        speechEnd: 0,
        end: 0,
        yieldedAt: null,
        retried: false,
        skipped: false,
        moderatorSpokeAt: null,
      };
      this.steps.push(record);
      const agendaBefore = this.agendaIndex;
      if (step.until === "advance" && agendaBefore > 0) {
        // 主持人自己推进了，不用再有人提
        record.skipped = true;
        record.end = this.now();
        continue;
      }
      record.yieldedAt = await this.say(
        step.say,
        step.text,
        step.id,
        step.watch,
        record
      );
      record.speechEnd = this.now();
      if (step.then === "reply") await this.floorToModerator();
      else await sleep(800);

      if (
        step.until === "advance" &&
        step.retry &&
        this.agendaIndex === agendaBefore
      ) {
        record.retried = true;
        await this.say(step.say, step.retry, `${step.id}:retry`, step.watch);
        await this.floorToModerator();
      }
      record.end = this.now();
    }

    // 会议总结由系统宣布，比主持人自己开口晚一点
    const asked = this.steps[this.steps.length - 1]?.start ?? this.now();
    const waitFrom = performance.now();
    while (performance.now() - waitFrom < 20000) {
      if (this.moderatorText(asked).includes("会议到此结束")) {
        await this.waitReply(1000);
        break;
      }
      await sleep(100);
      this.check();
    }

    await sleep(2000);
    await this.endMeeting();
  }

  private async endMeeting(): Promise<void> {
    this.log("结束会议", "向主持人发出结束指令");
    const asked = performance.now();
    try {
      await this.room.localParticipant.performRpc({
        destinationIdentity: this.agent.identity,
        method: "pg.endMeeting",
        payload: "{}",
      });
    } catch (err) {
      this.log("结束指令失败", err instanceof Error ? err.message : String(err));
      return;
    }
    while (!this.ended && performance.now() - asked < 8000) await sleep(100);
  }

  // ---- 检查 ---------------------------------------------------------------------

  private moderatorText(from: number, to = Infinity): string {
    return [...this.transcript.values()]
      .filter((s) => s.role === "moderator" && s.t >= from && s.t <= to)
      .sort((a, b) => a.t - b.t)
      .map((s) => s.text)
      .join(" ");
  }

  private step(id: string): StepRecord | undefined {
    return this.steps.find((s) => s.id === id);
  }

  private analyse(): DemoFinding[] {
    const findings: DemoFinding[] = [];
    const add = (name: string, ok: boolean | null, detail: string) =>
      findings.push({ name, ok, detail });
    const first = this.steps[0];
    const finished = this.steps.length === DEMO_STEPS.length;

    // 开场
    const opening = this.moderatorText(0, first ? first.start : Infinity);
    add(
      "开场播报",
      !!opening && opening.includes(DEMO_CONFIG.agendas[0].title),
      opening ? `「${opening.slice(0, 80)}」` : "没有收到主持人的开场白"
    );
    add(
      "开场后指定第一位发言人",
      opening.includes(DEMO_CONFIG.agendas[0].presenter ?? ""),
      opening.includes(DEMO_CONFIG.agendas[0].presenter ?? "")
        ? `请了${DEMO_CONFIG.agendas[0].presenter}先介绍情况`
        : "开场白里没有请汇报人发言"
    );

    // 正常发言时不插话
    const quiet = this.steps.filter(
      (s) => !s.expect && !s.skipped && s.moderatorSpokeAt !== null
    );
    add(
      "正常发言时保持安静",
      quiet.length === 0,
      quiet.length === 0
        ? "参会人讲话期间主持人没有插话"
        : `在这些发言中途开了口：${quiet.map((s) => s.id).join("、")}`
    );

    // 跑题
    const off = this.step("off_topic");
    if (off) {
      const warning = this.driftWarnings.find((w) => w.t >= off.start);
      const spoke = off.moderatorSpokeAt;
      const parts = [
        warning
          ? `跑题开始后 ${(warning.t - off.start).toFixed(1)} 秒出现提示`
          : "没有出现跑题提示",
        spoke !== null
          ? `${(spoke - off.start).toFixed(1)} 秒时主持人已开口`
          : "发言人讲完之前主持人没有开口",
      ];
      add("跑题打断", !!warning && off.yieldedAt !== null, parts.join("，"));
      const after = this.moderatorText(off.start, this.step("proposal")?.start);
      add(
        "打断的话说到了当前议题",
        after.includes(DEMO_CONFIG.agendas[0].title),
        after ? `「${after.slice(0, 80)}」` : "没有收到主持人的话"
      );
    }

    // 决议
    const proposal = this.step("proposal");
    const complete = this.step("complete");
    const all = [...this.decisions.values()].flat();
    const full = (d: any) =>
      !!(d.owner && d.dueDate && d.verification && d.evidence);
    if (proposal && complete) {
      const early = all.filter((v) => v.t < complete.start && full(v.data));
      add(
        "要素不全时不编造",
        early.length === 0,
        early.length === 0
          ? "方案只说了责任人时，主持人没有记成四要素齐全的决议"
          : `只听到责任人就记下了完整决议：时限「${early[0].data.dueDate}」、验证「${early[0].data.verification}」`
      );
      const asked = this.moderatorText(proposal.start, complete.start);
      // 不追问不算错：参会人可能正要接着说。这一项只记录，不判对错。
      add(
        "追问缺少的要素",
        /时限|什么时候|验证|证据/.test(asked) ? true : null,
        asked ? `「${asked.slice(0, 80)}」` : "主持人没有追问，参会人自己补上了"
      );
    }
    const last = [...this.decisions.values()].map((v) => v[v.length - 1].data);
    const good = last.find(
      (d) => full(d) && /李/.test(d.owner) && /(十|10)\s*月/.test(d.dueDate)
    );
    add(
      "记录四要素齐全的决议",
      !!good,
      good
        ? `${good.decision}（${good.owner}，${good.dueDate}）`
        : last.length
        ? `记录了 ${last.length} 条，但责任人或时限与会上说的不符`
        : "没有记录任何决议"
    );

    // 点名
    const required = DEMO_CONFIG.attendees
      .filter((a) => a.required)
      .map((a) => a.name);
    const called = new Set(this.rollCalls.map((c) => c.name));
    const missing = required.filter((n) => !called.has(n));
    add(
      "点名征询必须发言的人",
      missing.length === 0,
      missing.length === 0
        ? `点到了${required.join("、")}`
        : `没有点到${missing.join("、")}`
    );

    // 推进
    const close = this.step("close_1");
    if (close) {
      add(
        "推进到下一项议题",
        this.agendaIndex >= 1,
        this.agendaIndex >= 1
          ? close.skipped
            ? "主持人自己推进了"
            : close.retried
            ? "第二次要求后才推进"
            : "第一次要求后就推进了"
          : "议程没有推进"
      );
      const said = this.moderatorText(
        Math.min(close.start, this.advancedAt ?? close.start) - 2,
        this.step("plan")?.start
      );
      add(
        "新议题请汇报人先讲",
        said.includes(DEMO_CONFIG.agendas[1].presenter ?? ""),
        said ? `「${said.slice(-80)}」` : "没有收到主持人的话"
      );
    }

    // 未决事项
    const open = this.openItems.map((o) => o.data);
    add(
      "登记未决事项",
      open.length === 1 && /赵/.test(open[0].owner ?? ""),
      open.length
        ? `${open.length} 条：${open[0].issue}（跟进人：${open[0].owner || "缺"}）`
        : "没有登记"
    );

    // 总结
    const wrap = this.step("wrap_up");
    if (wrap) {
      const summary = this.moderatorText(wrap.start);
      add(
        "会议总结",
        /决议/.test(summary) && /未决/.test(summary),
        summary ? `「${summary.slice(0, 100)}」` : "主持人没有做总结"
      );
    }

    add(
      "结束会议",
      finished ? this.ended : null,
      this.ended
        ? "主持人收到指令后关闭了房间"
        : finished
        ? "发出结束指令后 8 秒内房间没有关闭"
        : "演示没有走完"
    );

    const room = [...this.transcript.values()].filter((s) => s.role === "room");
    add(
      "实时转写",
      room.length > 0,
      `会场 ${room.length} 段，主持人 ${this.transcript.size - room.length} 段`
    );
    return findings;
  }
}

export type { DemoStep };
