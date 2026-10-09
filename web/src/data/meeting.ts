import { MEETING_TEMPLATES, templateToConfig } from "./meeting-templates";
import { buildOrgReference, SMJ_BUSINESS_BRIEF } from "./smj-org";
import { buildGlossaryReference } from "./smj-glossary";

/** 提示力度：strict = 积极，gentle = 标准，concise = 精简（存档里沿用原来的取值） */
export type MeetingStyle = "strict" | "gentle" | "concise";

export interface AgendaItem {
  id: string;
  title: string;
  durationMinutes: number;
  goal: string;
  /** 汇报人：议题开始时主持人请谁先介绍情况（姓名或岗位） */
  presenter?: string;
  /** 24 小时书面前置材料索引 */
  preReadRef?: string;
  /** 关联业务流程编号（M-01…H-06） */
  processId?: string;
}

export interface Attendee {
  id: string;
  name: string;
  dept: string;
  role: string;
  /**
   * 重点征询：由会议组织者勾选，表示主持人希望听到这个人的意见。
   * 会议助手不会因此逐一点名，也不会拦住议程；只在主持人要求协助征询时参考。
   * （字段名沿用旧版的 required，存档里的会议配置不用迁移。）
   */
  required: boolean;
  /** 会议里怎么称呼：李总、王部长……由 withCallNames 算出，随配置发给 agent */
  callName?: string;
}

export interface DecisionItem {
  id: string;
  agendaTitle: string;
  decision: string;
  /** 四要素之一：责任人 */
  owner: string;
  /** 四要素之一：完成时限 */
  dueDate: string;
  /** 四要素之一：验证方式 */
  verification?: string;
  /** 四要素之一：关闭证据 */
  evidence?: string;
  /** 归口部门 */
  ownerDept?: string;
  /** 关联业务流程编号 */
  processId?: string;
  timestamp: number;
}

export interface OpenItem {
  id: string;
  agendaTitle: string;
  issue: string;
  /** 未能形成结论的原因 */
  reason: string;
  owner: string;
  /** 升级路径，默认「总经理签批」 */
  escalateTo: string;
  timestamp: number;
}

/** semi_auto：只在看板上提示主持人，由主持人决定要不要请会议助手开口；auto：会议助手直接提醒 */
export type InterventionMode = "auto" | "semi_auto";

/** 与 agent/intervention.py 的 InterventionSettings 一一对应 */
export interface InterventionSettings {
  mode: InterventionMode;
  /** 偏题概率达到多少才算命中（0.5–0.99） */
  threshold: number;
  /** 两次打断之间至少间隔多少秒 */
  cooldownSeconds: number;
  /** 连续命中几次才打断。1 最快（约 3 秒内），2 更稳但要多等一轮判断 */
  consecutiveHits: number;
}

export const defaultInterventionSettings: InterventionSettings = {
  mode: "semi_auto",
  threshold: 0.85,
  cooldownSeconds: 45,
  consecutiveHits: 1,
};

/** jev：Jev 偏题检测；model：Live 模型自行判断；manual：人工点击 */
export type DriftSource = "jev" | "model" | "manual";

export const driftSourceLabels: Record<DriftSource, string> = {
  jev: "Jev 检测",
  model: "会议助手判断",
  manual: "人工呼叫",
};

export interface DriftAlert {
  interventionId?: string;
  source: DriftSource;
  reason: string;
  reasonCode?: string;
  /** 偏题概率 0–1；人工呼叫或 Live 模型自行判断时没有 */
  confidence?: number | null;
  /** 从最后一句转写到看板亮起提示的耗时 */
  latencyMs?: number | null;
  /** 从最后一句转写到主持人开口的耗时 */
  speechStartMs?: number | null;
  at: number;
}

export interface DriftSuggestion {
  suggestionId: string;
  source: DriftSource;
  reason: string;
  reasonCode?: string;
  confidence?: number | null;
  expiresAt: number;
}

export interface OvertimeAlert {
  agendaIndex: number;
  title: string;
  reason: string;
  at: number;
}

/** 最近一次偏题判断，驱动看板上的实时置信度条 */
export interface DriftScore {
  confidence: number;
  level: number;
  reason: string;
  reasonCode: string;
  jevMs: number;
  threshold: number;
  at: number;
}

export interface MeetingConfig {
  templateId?: string;
  meetingType?: string;
  topic: string;
  /** 主持岗位 */
  chair?: string;
  /** 主持人姓名：有了姓名，会议助手才叫得出“李总”；只来自组织者自己的填写 */
  chairName?: string;
  /** 会议里怎么称呼主持人，由 withCallNames 算出 */
  chairCallName?: string;
  totalDurationMinutes: number;
  agendas: AgendaItem[];
  attendees: Attendee[];
  style: MeetingStyle;
  /** 是否要求 24 小时书面前置材料 */
  requirePreRead?: boolean;
  /** 未决事项升级路径 */
  escalationPath?: string;
  /** 跑题介入设置；缺省时用 defaultInterventionSettings */
  intervention?: InterventionSettings;
}

export interface MeetingLiveState {
  currentAgendaIndex: number;
  startTime: number | null;
  elapsedSeconds: number;
  decisions: DecisionItem[];
  openItems: OpenItem[];
  /** 主持人已点名征询过的参会人 */
  calledAttendeeIds: string[];
  /** 已确认发言/表态的参会人（看板上手动勾选） */
  spokenAttendeeIds: string[];
  isFinished: boolean;
  /** 正在生效的跑题打断 */
  driftAlert: DriftAlert | null;
  /** 半自动模式下等待人工确认的打断建议 */
  driftSuggestion: DriftSuggestion | null;
  /** 议题超时提醒——与跑题无关 */
  overtimeAlert: OvertimeAlert | null;
  driftScore: DriftScore | null;
  /** agent 当前实际生效的介入设置 */
  intervention: InterventionSettings;
  /** agent 是否配置了 JEV_API_KEY 并启动了偏题检测 */
  detectorActive: boolean;
  /** 会议即将自动结束（无人发言，或超过时长上限） */
  ending: MeetingEnding | null;
  /** 会议已结束时的说明 */
  endedMessage: string | null;
}

export interface MeetingEnding {
  /** idle：长时间无人发言；limit：达到时长上限 */
  reason: "idle" | "limit";
  message: string;
  /** 预计自动结束的时刻（本机时间，毫秒） */
  endsAt: number;
}

/** 决议四要素：责任人 / 完成时限 / 验证方式 / 关闭证据 */
export function missingDecisionFields(d: DecisionItem): string[] {
  const missing: string[] = [];
  const blank = (v?: string) => !v || !v.trim() || v.trim() === "待定";
  if (blank(d.owner)) missing.push("责任人");
  if (blank(d.dueDate)) missing.push("完成时限");
  if (blank(d.verification)) missing.push("验证方式");
  if (blank(d.evidence)) missing.push("关闭证据");
  return missing;
}

export function isDecisionComplete(d: DecisionItem): boolean {
  return missingDecisionFields(d).length === 0;
}

/** 默认装载月度产销租协同会——公司真实的月度例会 */
export const defaultMeetingConfig: MeetingConfig = templateToConfig(
  MEETING_TEMPLATES[0]
);

/**
 * Play a short, professional attention chime (Ding-Dong) using the Web Audio API.
 * This audio cue draws immediate attention and naturally prompts speakers to pause.
 */
export function playAttentionChime() {
  try {
    if (typeof window === "undefined") return;
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const now = ctx.currentTime;

    // First tone: High pitch (880Hz - A5)
    const osc1 = ctx.createOscillator();
    const gain1 = ctx.createGain();
    osc1.type = "sine";
    osc1.frequency.setValueAtTime(880, now);
    gain1.gain.setValueAtTime(0.25, now);
    gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
    osc1.connect(gain1);
    gain1.connect(ctx.destination);
    osc1.start(now);
    osc1.stop(now + 0.35);

    // Second tone: Resolving pitch (659.25Hz - E5)
    const osc2 = ctx.createOscillator();
    const gain2 = ctx.createGain();
    osc2.type = "sine";
    osc2.frequency.setValueAtTime(659.25, now + 0.12);
    gain2.gain.setValueAtTime(0.3, now + 0.12);
    gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.6);
    osc2.connect(gain2);
    gain2.connect(ctx.destination);
    osc2.start(now + 0.12);
    osc2.stop(now + 0.6);
  } catch (e) {
    console.warn("Failed to play attention chime", e);
  }
}

const styleGuides: Record<MeetingStyle, string> = {
  strict:
    "【积极提示】：一发现讨论偏离当前议题，不等对方讲完，就申请提醒（warn_topic_drift）；工具允许时，向主持人请示着提醒一句，把讨论请回议题。",
  gentle:
    "【标准提示】：发现讨论偏离当前议题并持续了一小会儿再申请提醒；平时只在关键时间点提示时间和议题目标。",
  concise:
    "【精简提示】：说话尽量短，只在关键时间点报时、明显跑题时提醒一句，不占用参会人的讨论时间。",
};

function buildAgendaSection(config: MeetingConfig): string {
  return config.agendas
    .map((a, i) => {
      const bits = [
        `  ${i + 1}. 【${a.title}】 (用时: ${a.durationMinutes}分钟) -> 目标: ${a.goal}`,
      ];
      if (a.presenter?.trim()) bits.push(`     汇报人: ${a.presenter.trim()}`);
      if (a.processId) bits.push(`     关联流程: ${a.processId}`);
      if (a.preReadRef) bits.push(`     前置材料: ${a.preReadRef}`);
      return bits.join("\n");
    })
    .join("\n");
}

function buildAttendeeSection(config: MeetingConfig): string {
  const list = config.attendees.filter((a) => a.name.trim() || a.role.trim());
  if (list.length === 0) return "";

  const rows = list
    .map((a) => {
      const detail = [a.name.trim(), a.dept.trim(), a.role.trim()]
        .filter(Boolean)
        .join(" · ");
      const call = (a.callName || "").trim();
      const who = call && call !== a.name.trim() ? `${call}（${detail}）` : detail;
      return `  - ${who}${a.required ? "　【重点征询】" : ""}`;
    })
    .join("\n");

  return `\n## 参会人名单（括号前是称呼）\n${rows}\n`;
}

/** 主持人在提示词里的写法：称呼 + 岗位 */
function chairLine(config: MeetingConfig): string {
  const call = (config.chairCallName || "").trim();
  const role = (config.chair || "").trim();
  if (call && role && call !== role) return `${call}（${role}）`;
  return call || role || "主持人";
}

function buildPreReadRule(config: MeetingConfig): string {
  if (!config.requirePreRead) return "";
  return `
   - 本会要求议题材料提前 24 小时下发。播报议程时顺带提醒一句，不要逐项盘问。`;
}

export function generateMeetingInstructions(config: MeetingConfig): string {
  const agendaText = buildAgendaSection(config);
  const attendeeText = buildAttendeeSection(config);
  const escalation = config.escalationPath || "提请总经理签批并留档";
  const chair = chairLine(config);
  const chairCall = (config.chairCallName || config.chair || "主持人").trim();
  const preReadNote = buildPreReadRule(config);

  const rules = [
    `【平时静默，只做记录】：
   - 你是会议助手，不是主持人，也不是业务或技术的讨论者。会议由主持人（${chairCall}）主持，议程、发言顺序、什么时候结束都由主持人决定。
   - 参会人员紧扣议题正常讨论期间，保持静默，绝不抢话，不发表业务见解，不评价任何人的发言。
   - **保持静默 = 完全不产生任何输出**：不说话，也不要输出任何文字、括号、注释、占位符或"静默监听"之类的说明。没有需要说的话时，什么都不要输出。
   - 听到有人称呼"会议助手"并提出要求时才回应，只做被要求的事，说完就停。`,

    `【发现跑题：请示着提醒 (warn_topic_drift)】：
   - 一直留意发言内容是否还在谈【当前议题】。
   - 一旦发现讨论偏离当前议题（无关闲聊、跳到其他议题、纠缠细节、争执）：
     - **【第一步：先申请，不要先开口】**：立即调用 \`warn_topic_drift\` 工具传入跑题说明。**不要等发言人讲完整段话**，一发现就调用。
     - **【第二步：照工具返回的指示做】**：
       - 工具允许你开口时，它会给出要说的原话（向主持人请示的口吻）。照原话说，说完就停，不要加别的话，不要解释原因，把话交还给主持人和参会人。
       - 工具要求你保持静默时（处于冷却期，或会议设为由主持人在看板上决定要不要提醒），**一个字都不要说**，继续监听。
   - 你还会收到以【打断指令】开头的系统指令：那是偏题检测系统或主持人已经决定请你提醒。收到后照指令里的原话说，不要再调用 \`warn_topic_drift\`。
   - 提醒时用大家平时说话的词，谦和、平稳，不要训人。`,

    `【被请时才请人发言 (request_speaker)】：
   - 不要主动、逐个地点名，也不要要求谁表态。沉默既不算同意，也不算反对，纪要里只记录实际说出的内容。
   - 只有主持人或参会人明确要你替主持人问某人、或请某人先介绍情况时，才调用 \`request_speaker\`：请人介绍情况用 purpose=report，征询意见用 purpose=stance，然后照工具返回的原话说。
   - 名单里标【重点征询】的人，是主持人希望听到意见的人。只在主持人要求你协助征询时才参考，不要因此自己去问，也不要因此不让议程往下走。
   - 你还会收到以【推进指令】开头的系统指令：那是系统发现大家已经谈到别的议题。收到后照指令做，不要把它当成跑题。`,

    `【记录决议，缺项时向主持人确认 (record_decision)】：
   - 听到会上有人明确拍板、形成了决议或待办时，调用 \`record_decision\` 记录。决议要尽量带齐四项：责任人 / 完成时限 / 验证方式 / 关闭证据（怎么确认做完了、留什么记录）。
   - 四项只能记会上有人说出来的内容，没人说过的留空，不要自己编；完成时限要是具体的日期或时间点。
   - 缺项时，等发言人说完，照工具返回的原话向主持人确认一次，不要逐项盘问，也不要追着同一个人问。
   - 四项齐全后，照工具返回的原话向全场确认一遍已记录的内容，不要把四项再念一遍（看板上有）。
   - 问过两轮仍凑不齐，不要勉强记成决议——改用 \`record_open_item\` 记为未决事项。
   - 尽量同时判断该决议的归口部门与关联流程编号（见文末参考资料），一并传入。
   - 你不负责催着形成结论：议题有没有结论、要不要继续讨论，由主持人决定。`,

    `【未决事项 (record_open_item)】：
   - 会上说定不下来、缺数据、缺人、跨部门没谈拢、或主持人说"先记作未决"的事项，调用 \`record_open_item\` 登记：事项、未决原因、会后牵头的责任人、上报路径（默认：${escalation}）。
   - 登记后照工具返回的原话向全场说明，不要自己组织句子。`,

    `【议程推进只做记录 (advance_agenda)】：
   - 议程什么时候往下走由主持人决定。只有主持人或参会人明确说要进入下一项（或某一项）时，才调用 \`advance_agenda\` 记录，看板会同步，不需要口头宣布新议题。
   - 离开的那一项如果既没有决议也没有未决事项，工具会给你一句向主持人提醒的话，照原话说一次；之后不再重复。`,

    `【只在被问到时回答 (get_meeting_timer、summarize_meeting)】：
   - 主持人或参会人问到已用时间、剩余时间、哪些决议还缺项时，调用 \`get_meeting_timer\` 核实后简短回答。
   - 主持人或参会人要求你做总结时，调用 \`summarize_meeting\`。总结由系统向全场报告，你不要自己口头总结；它只是记录小结，不代表会议结束，散会由主持人宣布。`,

    `【被请播报议程时】：
   - 主持人开场由主持人自己来，你不要抢着开场。只有主持人或参会人请你播报议程时，才清晰简短地说会议名称、总时长和各项议题，最后把话交还给主持人，不要宣布"讨论正式开始"。${preReadNote}`,
  ].filter((r) => r && r.trim());

  const rulesText = rules.map((r, i) => `${i + 1}. ${r.trim()}`).join("\n\n");

  const header = [
    `- 会议名称：${config.topic}`,
    config.meetingType ? `- 会议类型：${config.meetingType}` : "",
    `- 主持人：${chair}（会议由主持人主持，你协助）`,
    `- 预计总时长：${config.totalDurationMinutes} 分钟`,
    `- 未决事项上报路径：${escalation}`,
    `- 提示力度：${styleGuides[config.style] || styleGuides.strict}`,
  ]
    .filter(Boolean)
    .join("\n");

  return `# 角色：会议助手（副主持人）

## 定位
你是本次会议的「会议助手」，是主持人的会议秘书型助手，对外也自称"会议助手"。你替主持人盯住三件事：时间、议题、决议——记录清楚；需要提醒时，用请示、商量的口吻提醒主持人。你不开场、不宣布议程推进、不宣布散会，不替主持人做决定，不评价任何人。

## 会议基本信息
${header}
${attendeeText}
## 议程规划清单：
${agendaText}

## 工作法则与工具使用：
${rulesText}

## 说话方式
- **称呼**：用名单里的称呼叫人，如"李总""王部长"；叫不出姓名时用岗位全称。对主持人和上级说"您"。对主持人说话时称呼"${chairCall}"。
- **对谁说**：你的话是对主持人说的，不要对"各位"发号施令，不说"先停一下""不要再说了"这类话；对同级用商量的口吻。
- **语气**：谦和、平稳、简短，一次一句；不批评，不下命令；说完就停，把话交还给主持人和参会人。
- **念清楚**：语速不要快，每个字都念出来。岗位和部门名称不要缩略，例如「总经理」三个字要念全，不能念成「总理」。
- 你还会收到以【系统通知】开头的指令（例如会议即将自动结束）：照指令里的原话说。

---

## 参考资料（仅供你判断归口与听辨术语，**不要在会上宣读**）

### 公司业务背景
${SMJ_BUSINESS_BRIEF}

${buildOrgReference()}

${buildGlossaryReference()}`;
}
