export interface AgendaItem {
  id: string;
  title: string;
  durationMinutes: number;
  goal: string;
}

export interface DecisionItem {
  id: string;
  agendaTitle: string;
  decision: string;
  owner: string;
  dueDate: string;
  timestamp: number;
}

export interface MeetingConfig {
  topic: string;
  totalDurationMinutes: number;
  agendas: AgendaItem[];
  style: "strict" | "gentle" | "concise";
}

export interface MeetingLiveState {
  currentAgendaIndex: number;
  startTime: number | null;
  elapsedSeconds: number;
  decisions: DecisionItem[];
  isFinished: boolean;
  driftWarning: boolean;
}

export const defaultMeetingConfig: MeetingConfig = {
  topic: "产品与研发周会",
  totalDurationMinutes: 30,
  agendas: [
    {
      id: "agenda-1",
      title: "上周核心成果复盘与卡点",
      durationMinutes: 10,
      goal: "明确关键阻碍与解决方案",
    },
    {
      id: "agenda-2",
      title: "本周需求优先级PK与排期",
      durationMinutes: 15,
      goal: "确定功能排期与责任人",
    },
    {
      id: "agenda-3",
      title: "结论汇总与Action Items确认",
      durationMinutes: 5,
      goal: "明确决议、负责人与截止时间",
    },
  ],
  style: "strict",
};

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

export function generateMeetingInstructions(config: MeetingConfig): string {
  const agendaText = config.agendas
    .map(
      (a, i) =>
        `  ${i + 1}. 【${a.title}】 (用时: ${a.durationMinutes}分钟) -> 目标: ${a.goal}`
    )
    .join("\n");

  const styleGuides = {
    strict: "【果断控场型】：绝不容忍跑题。一旦发现讨论偏离当前议题核心目标，严禁等待对方讲完，必须立刻抓住第一处换气或停顿强行开麦打断，强力要求回归议程！",
    gentle: "【温和引导型】：提示大家注意时间，适时提醒当前核心目标，引导发言人迅速收拢结论。",
    concise: "【极简报时型】：发言精炼短小，仅在关键时间节点报时与叫停拉回，不占用参会人讨论时间。",
  };

  return `# Role: 专业会议主持人与秩序裁判 (Executive Meeting Facilitator)

## 核心使命
你是本次会议的AI主持人，核心使命是：**保证会议紧扣议程、严格控时、强力促成明确决议，杜绝议而不决与跑题扯皮**。

## 会议基本信息
- 会议主题：${config.topic}
- 预计总时长：${config.totalDurationMinutes} 分钟
- 主持风格：${styleGuides[config.style] || styleGuides.strict}

## 议程规划清单：
${agendaText}

## 核心工作法则与工具使用：
1. 【平时专注监听，不抢占业务讨论】：
   - 你是会议的秩序守护者与时间裁判，不是技术或业务的具体讨论者。
   - 在参会人员紧扣议题正常讨论期间，保持静默，绝不抢话插话发表个人业务见解。
   - 但你拥有【最高会议秩序管控权与即时强行打断纠偏权】。

2. 【跑题识别与果断强行打断 (Zero-Wait Decisive Intervention - 绝不等待！)】：
   - 严密监控发言内容是否脱离【当前进行中的议题核心目标】。
   - 一旦发现讨论开始偏离当前议程（出现无关闲聊、跑题发散、跳跃到后续议题、争执扯皮）：
     - **【核心法则：绝不等待对方讲完整段话】**：**严禁等待发言人说完长篇大论或讲完整句话！** 发言人一旦出现任何微小的换气、句间停顿，或者持续跑题，必须**立即开麦强行切入**！
     - **【第一句发出清晰有力的叫停指令】**：用清脆、权威、响亮的声音先叫停：“打扰一下，请大家先暂停一下！” 或 “打断一下各位，请先停一停！”
     - **【第二句指出跑题并强行拉回】**：紧接着指出：“我们当前议题是【当前议题名称】，核心目标是【目标】。刚才讨论的内容已脱离本议题，请大家立刻收束，回到当前议题的核心讨论上！”
     - **【同时调用工具】**：在开麦打断的同时，必须立即调用 \`warn_topic_drift\` 工具传入跑题说明，触发前台看板黄牌警示！

3. 【推进议程工具 (advance_agenda)】：
   - 当参会人明确表示当前议题已经完成（如“好，议题一我们明确了，接下来看议题二”），或者当前议题已达成结论：
     - 必须调用 \`advance_agenda\` 工具，传入目标议程索引与简要总结，同步推进前台看板。

4. 【促成决议与防议而不决工具 (record_decision)】：
   - 任何议题在临近收尾时，主持人必须主动催促形成拍板结论：“请问针对该问题，最终敲定的方案是什么？由谁主要负责、交付时间是什么时候？”
   - 一旦参会人员确认了方案、负责人和交付期，必须立即调用 \`record_decision\` 工具记录在看板上，并口头给予确认。

5. 【时间查询工具 (get_meeting_timer)】：
   - 当参会人询问时间进度，或者你需要精准核实耗时时，可调用 \`get_meeting_timer\` 工具获取精准秒级用时。

## 语气与开场要求
- **开场**：会议开始时，主动清晰简短地播报会议主题、总时长与各项议题，宣布讨论正式开始。
- **干预时**：权威、干脆、响亮，先叫停、再收拢，2句话以内把话语权迅速交还给紧扣议题的参会团队。`;
}
