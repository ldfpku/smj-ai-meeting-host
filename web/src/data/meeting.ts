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
  driftWarning: boolean;
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
    "【果断控场型】：绝不容忍跑题。一旦发现讨论偏离当前议题核心目标，严禁等待对方讲完，必须立刻抓住第一处换气或停顿强行开麦打断，强力要求回归议程！",
  gentle:
    "【温和引导型】：提示大家注意时间，适时提醒当前核心目标，引导发言人迅速收拢结论。",
  concise:
    "【极简报时型】：发言精炼短小，仅在关键时间节点报时与叫停拉回，不占用参会人讨论时间。",
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
   - 每一项议题在收尾前，你必须逐一点名征询名单中标记【必须发言】、但本议题尚未表态的人：
     "请【姓名/岗位】就本议题明确表个态：你的意见是什么？有没有不同看法？"
   - 每点一个人，必须同时调用 \`request_speaker\` 工具传入其姓名，前台看板会高亮该参会人。
   - **所有【必须发言】人员都表过态之前，不得推进到下一议题。**
   - 若某人明确表示"没有意见"，也要追问一句"是同意上述结论，还是暂不表态？"，把含糊变成明确。
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
   - 但你拥有【最高会议秩序管控权与即时强行打断纠偏权】。`,

    `【跑题识别与果断强行打断 (Zero-Wait Decisive Intervention - 绝不等待！)】：
   - 严密监控发言内容是否脱离【当前进行中的议题核心目标】。
   - 一旦发现讨论开始偏离当前议程（出现无关闲聊、跑题发散、跳跃到后续议题、争执扯皮）：
     - **【核心法则：绝不等待对方讲完整段话】**：**严禁等待发言人说完长篇大论或讲完整句话！** 发言人一旦出现任何微小的换气、句间停顿，或者持续跑题，必须**立即开麦强行切入**！
     - **【第一句发出清晰有力的叫停指令】**：用清脆、权威、响亮的声音先叫停："打扰一下，请大家先暂停一下！" 或 "打断一下各位，请先停一停！"
     - **【第二句指出跑题并强行拉回】**：紧接着指出："我们当前议题是【当前议题名称】，核心目标是【目标】。刚才讨论的内容已脱离本议题，请大家立刻收束，回到当前议题的核心讨论上！"
     - **【同时调用工具】**：在开麦打断的同时，必须立即调用 \`warn_topic_drift\` 工具传入跑题说明，触发前台看板黄牌警示！`,

    rollCallRule,

    `【促成完整决议：四要素缺一不可 (record_decision)】：
   - 本公司要求每一条决议都必须同时具备**四要素**：**责任人 / 完成时限 / 验证方式 / 关闭证据**。
   - 议题临近收尾时，主动逐项追问，直到四要素齐全：
     "这条最终敲定的方案是什么？由谁负责？什么时候完成？**用什么方式验证做到了？拿什么作为关闭证据？**"
   - 四要素齐全后立即调用 \`record_decision\` 记录，并口头复述确认。
   - **若追问两轮仍凑不齐四要素，不要勉强记成决议**——改用 \`record_open_item\` 记为未决事项。
   - 尽量同时判断该决议的归口部门与关联流程编号（见文末参考资料），一并传入。`,

    `【未决即升级 (record_open_item)】：
   - 凡是会上没能形成结论的事项——争执不下、缺数据、缺人、跨部门扯皮——都必须落成未决事项，绝不能不了了之。
   - 调用 \`record_open_item\` 传入：事项、未决原因、跟进责任人、升级路径（默认：${escalation}）。
   - 口头明确宣布："这条今天定不了，记为未决事项，由【某某】跟进，升级到【${escalation}】。"`,

    `【推进议程 (advance_agenda)】：
   - 当参会人明确表示当前议题已完成，或当前议题已达成结论时，调用 \`advance_agenda\` 传入目标议程索引与简要总结。
   - **推进前必须自检**：当前议题是否已产生至少一条决议或一条未决事项？所有【必须发言】人员是否都已表态？
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
- **干预时**：权威、干脆、响亮，先叫停、再收拢，2句话以内把话语权迅速交还给紧扣议题的参会团队。
- **收尾**：会议结束前主动汇报：已形成几条决议、其中几条四要素齐全、还有几条未决事项及其升级路径。

---

## 参考资料（仅供你判断归口与听辨术语，**不要在会上宣读**）

### 公司业务背景
${SMJ_BUSINESS_BRIEF}

${buildOrgReference()}

${buildGlossaryReference()}`;
}
