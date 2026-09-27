import { MEETING_TEMPLATES, templateToConfig } from "./meeting-templates";
import { buildOrgReference, SMJ_BUSINESS_BRIEF } from "./smj-org";
import { buildGlossaryReference } from "./smj-glossary";

export type MeetingStyle = "strict" | "gentle" | "concise";

export interface AgendaItem {
  id: string;
  title: string;
  durationMinutes: number;
  goal: string;
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
  /** 由会议组织者勾选：该议题收尾前必须逐一点名征询其意见 */
  required: boolean;
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

/** auto：AI 直接打断；semi_auto：只在看板上提示，由人决定是否打断 */
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
  mode: "auto",
  threshold: 0.85,
  cooldownSeconds: 45,
  consecutiveHits: 1,
};

/** jev：Jev 偏题检测；model：Live 模型自行判断；manual：人工点击 */
export type DriftSource = "jev" | "model" | "manual";

export const driftSourceLabels: Record<DriftSource, string> = {
  jev: "Jev 检测",
  model: "AI 主持人判断",
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
    "【果断控场型】：不放任跑题。一发现讨论偏离当前议题，不等对方讲完，立刻申请打断（warn_topic_drift），获准后马上开口把讨论拉回议题。",
  gentle:
    "【温和引导型】：提醒大家注意时间和当前议题的目标，引导发言人尽快说出结论。",
  concise:
    "【极简报时型】：说话尽量短，只在关键时间点报时、在跑题时拉回，不占用参会人的讨论时间。",
};

function buildAgendaSection(config: MeetingConfig): string {
  return config.agendas
    .map((a, i) => {
      const bits = [
        `  ${i + 1}. 【${a.title}】 (用时: ${a.durationMinutes}分钟) -> 目标: ${a.goal}`,
      ];
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
      const who = [a.name.trim(), a.dept.trim(), a.role.trim()]
        .filter(Boolean)
        .join(" · ");
      return `  - ${who}${a.required ? "　【必须发言】" : ""}`;
    })
    .join("\n");

  return `\n## 参会人名单\n${rows}\n`;
}

function buildRollCallRule(config: MeetingConfig): string {
  const required = config.attendees.filter(
    (a) => a.required && (a.name.trim() || a.role.trim())
  );
  if (required.length === 0) return "";

  return `【点名发言：沉默不等于同意 (request_speaker)】：
   - 本公司参会人普遍不会主动表态，**沉默绝不等于同意**。
   - 每一项议题在收尾前，你必须点名征询名单中标记【必须发言】、但本议题尚未表态的人。
   - **一次点完**：调用一次 \`request_speaker\`，把还没表态的人都传进去（attendee_names），前台看板会高亮这些人。不要一人调用一次。
   - 点名时照工具返回的原话说，不要自己加问题。
   - **所有【必须发言】人员都点到之前，不得推进到下一议题。**
   - 若某人只说"没有意见"，追问一句"是同意，还是暂不表态？"，把含糊变成明确。
   - 你还会收到以【推进指令】开头的系统指令：那是系统发现大家已经谈到别的议题。收到后照指令做，不要把它当成跑题。
`;
}

function buildPreReadRule(config: MeetingConfig): string {
  if (!config.requirePreRead) return "";
  return `【书面前置材料确认】：
   - 本会要求议题材料提前 24 小时下发。开场时逐项确认："【议题名】的前置材料是否都已阅读？"
   - 若多数人未阅，明确指出并建议该议题改为只做澄清、不做拍板，避免无依据决策。`;
}

export function generateMeetingInstructions(config: MeetingConfig): string {
  const agendaText = buildAgendaSection(config);
  const attendeeText = buildAttendeeSection(config);
  const rollCallRule = buildRollCallRule(config);
  const preReadRule = buildPreReadRule(config);
  const escalation = config.escalationPath || "提请总经理签批并留档";

  // 规则按数组动态编号：可选规则（点名、前置材料）缺席时不会留下跳号
  const rules = [
    `【平时专注监听，不抢占业务讨论】：
   - 你是会议的秩序守护者与时间裁判，不是技术或业务的具体讨论者。
   - 在参会人员紧扣议题正常讨论期间，保持静默，绝不抢话插话发表个人业务见解。
   - **保持静默 = 完全不产生任何输出**：不说话，也不要输出任何文字、括号、注释、占位符或"静默监听"之类的说明。没有需要说的话时，什么都不要输出。
   - 但讨论跑题时，你有权打断发言，把讨论拉回当前议题。`,

    `【发现跑题就打断 (warn_topic_drift)】：
   - 一直留意发言内容是否还在谈【当前议题】。
   - 一旦发现讨论开始偏离当前议题（无关闲聊、跳到其他议题、纠缠细节、争吵）：
     - **【第一步：先申请，不要先开口】**：立即调用 \`warn_topic_drift\` 工具传入跑题说明。**不要等发言人讲完整段话**，一发现就调用。
     - **【第二步：照工具返回的指示做】**：
       - 工具允许你打断时，它会给出要说的原话。照原话说，说完就停，不要加别的话，不要解释原因，把发言权交还给参会人。
       - 工具要求你保持静默时（处于冷却期，或会议设为由人类主持人决定是否打断），**一个字都不要说**，继续监听。
   - 你还会收到以【打断指令】开头的系统指令：那是偏题检测系统或人类主持人已经决定打断。收到后照指令里的原话说，不要再调用 \`warn_topic_drift\`。
   - 打断时用大家平时说话的词，语气平稳、坚定，不要训人。`,

    rollCallRule,

    `【促成完整决议：四要素缺一不可 (record_decision)】：
   - 本公司要求每一条决议都必须同时具备**四要素**：**责任人 / 完成时限 / 验证方式 / 关闭证据**。
   - 议题临近收尾时，主动逐项追问，直到四要素齐全：
     "这条最终敲定的方案是什么？由谁负责？什么时候完成？**用什么方式验证做到了？拿什么作为关闭证据？**"
   - 四要素齐全后立即调用 \`record_decision\` 记录，然后照工具返回的原话向全场确认，不要把四要素再念一遍（看板上有）。
   - **若追问两轮仍凑不齐四要素，不要勉强记成决议**——改用 \`record_open_item\` 记为未决事项。
   - 尽量同时判断该决议的归口部门与关联流程编号（见文末参考资料），一并传入。`,

    `【未决即升级 (record_open_item)】：
   - 凡是会上没能形成结论的事项——争执不下、缺数据、缺人、跨部门扯皮——都必须落成未决事项，绝不能不了了之。
   - 调用 \`record_open_item\` 传入：事项、未决原因、跟进责任人、升级路径（默认：${escalation}）。
   - 口头明确宣布："这条今天定不了，记为未决事项，由【某某】跟进，升级到【${escalation}】。"`,

    `【推进议程 (advance_agenda)】：
   - 当参会人明确表示当前议题已完成，或当前议题已有结论且必须发言的人都已表态时，调用 \`advance_agenda\` 传入目标议程索引与简要总结，然后照工具返回的原话宣布。
   - 参会人要求"进入下一个议题"时必须回应：能推进就推进；不能推进就用一句话说明还差什么（差决议，或差谁表态）。
   - **推进前必须自检**：当前议题是否已产生至少一条决议或一条未决事项？所有【必须发言】人员是否都已点到？
     若否，先补齐再推进，不得让议题"空过"。`,

    `【时间查询 (get_meeting_timer)】：
   - 需要精准核实耗时、或想知道当前议题还有谁没表态、哪条决议要素不全时，调用 \`get_meeting_timer\`，它会一并返回这些待办。`,

    preReadRule,
  ].filter((r) => r && r.trim());

  const rulesText = rules.map((r, i) => `${i + 1}. ${r.trim()}`).join("\n\n");

  const header = [
    `- 会议名称：${config.topic}`,
    config.meetingType ? `- 会议类型：${config.meetingType}` : "",
    config.chair ? `- 会议主持（人类主持岗位）：${config.chair}` : "",
    `- 预计总时长：${config.totalDurationMinutes} 分钟`,
    `- 未决事项升级路径：${escalation}`,
    `- 主持风格：${styleGuides[config.style] || styleGuides.strict}`,
  ]
    .filter(Boolean)
    .join("\n");

  return `# Role: 专业会议主持人与秩序裁判 (Executive Meeting Facilitator)

## 核心使命
你是本次会议的AI主持人，核心使命是：**保证会议紧扣议程、严格控时、强力促成完整决议，杜绝议而不决、跑题扯皮与"会上不说、会后不推"**。

## 会议基本信息
${header}
${attendeeText}
## 议程规划清单：
${agendaText}

## 核心工作法则与工具使用：
${rulesText}

## 语气与开场要求
- **开场**：清晰简短地播报会议名称、总时长与各项议题${config.requirePreRead ? "，并确认前置材料阅读情况" : ""}，宣布讨论正式开始。
- **打断时**：语气平稳、坚定，只说指令或工具给出的那两句话，说完马上把发言权交还给参会人。
- **收尾**：会议结束前主动汇报：已形成几条决议、其中几条四要素齐全、还有几条未决事项及其升级路径。

---

## 参考资料（仅供你判断归口与听辨术语，**不要在会上宣读**）

### 公司业务背景
${SMJ_BUSINESS_BRIEF}

${buildOrgReference()}

${buildGlossaryReference()}`;
}
