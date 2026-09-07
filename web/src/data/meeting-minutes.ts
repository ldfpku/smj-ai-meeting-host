import {
  MeetingConfig,
  MeetingLiveState,
  DecisionItem,
  OpenItem,
  missingDecisionFields,
} from "./meeting";

/**
 * 生成 SMJ 会议纪要（Markdown）
 *
 * 字段依据散落在管理语料中的留痕要求汇总而成——公司此前没有统一的纪要模板：
 *  - 决议须带 责任人 / 完成时限 / 验证方式 / 关闭证据（五类台账的留痕要求）
 *  - 未决事项须写明升级路径（如 P-01：会中未决的临时插单由总经理签批，PMC 留档）
 *  - 决议以书面纪要发出并要求**回执确认**（DISC 报告 §5.3 第三条：
 *    高 S 群体"当面认同、事后不动"，书面回执是唯一可靠的确认方式）
 *  - 纪要编制人为 综合管理部·行政后勤专员（其岗位职责第 4 条）
 */

function fmtDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m} 分 ${s.toString().padStart(2, "0")} 秒`;
}

function fmtDateTime(d: Date): string {
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`;
}

function attendeeLines(config: MeetingConfig): string[] {
  const list = config.attendees.filter((a) => a.name.trim() || a.role.trim());
  if (list.length === 0) return ["（未登记参会人名单）"];

  // 按部门归组列名
  const byDept = new Map<string, string[]>();
  for (const a of list) {
    const dept = a.dept.trim() || "未注明部门";
    const who =
      [a.name.trim(), a.role.trim()].filter(Boolean).join("（") +
      (a.name.trim() && a.role.trim() ? "）" : "");
    const marks: string[] = [];
    if (a.required) marks.push("必须发言");
    byDept.set(dept, [
      ...(byDept.get(dept) || []),
      who + (marks.length ? ` [${marks.join("/")}]` : ""),
    ]);
  }

  return Array.from(byDept.entries()).map(
    ([dept, people]) => `- **${dept}**：${people.join("、")}`
  );
}

function decisionBlock(d: DecisionItem, idx: number): string {
  const missing = missingDecisionFields(d);
  const lines = [
    `${idx}. ${d.decision}`,
    `   - 责任人：${d.owner || "—"}${d.ownerDept ? `（${d.ownerDept}）` : ""}`,
    `   - 完成时限：${d.dueDate || "—"}`,
    `   - 验证方式：${d.verification || "—"}`,
    `   - 关闭证据：${d.evidence || "—"}`,
  ];
  if (d.processId) lines.push(`   - 关联流程：${d.processId}`);
  if (missing.length) {
    lines.push(`   - ⚠️ **要素不全，待补**：${missing.join("、")}`);
  }
  return lines.join("\n");
}

function openItemBlock(o: OpenItem, idx: number): string {
  return [
    `${idx}. ${o.issue}`,
    `   - 未决原因：${o.reason || "—"}`,
    `   - 跟进责任人：${o.owner || "—"}`,
    `   - 升级路径：${o.escalateTo || "—"}`,
  ].join("\n");
}

export interface MinutesInput {
  config: MeetingConfig;
  liveState: MeetingLiveState;
  elapsedSeconds: number;
  now?: Date;
}

export function generateMinutesMarkdown({
  config,
  liveState,
  elapsedSeconds,
  now = new Date(),
}: MinutesInput): string {
  const { decisions, openItems } = liveState;
  const completeCount = decisions.filter(
    (d) => missingDecisionFields(d).length === 0
  ).length;

  const lines: string[] = [];

  lines.push(`# 会议纪要：${config.topic}`);
  lines.push("");
  lines.push("## 一、会议基本信息");
  lines.push("");
  lines.push(`| 项目 | 内容 |`);
  lines.push(`|---|---|`);
  lines.push(`| 会议名称 | ${config.topic} |`);
  lines.push(`| 会议类型 | ${config.meetingType || "—"} |`);
  lines.push(`| 时间 | ${fmtDateTime(now)} |`);
  lines.push(`| 地点 | （待填写） |`);
  lines.push(`| 主持人 | ${config.chair || "（待填写）"} |`);
  lines.push(
    `| 计划时长 / 实际用时 | ${config.totalDurationMinutes} 分钟 / ${fmtDuration(
      elapsedSeconds
    )} |`
  );
  lines.push(`| 记录人 | （综合管理部·行政后勤专员） |`);
  lines.push("");

  lines.push("## 二、参会人");
  lines.push("");
  lines.push(...attendeeLines(config));
  lines.push("");
  lines.push("**缺席人**：（待填写，注明缺席原因与是否已书面征询意见）");
  lines.push("");

  lines.push("## 三、议题与讨论要点");
  lines.push("");
  config.agendas.forEach((item, idx) => {
    const isDone = idx < liveState.currentAgendaIndex;
    const isCur = idx === liveState.currentAgendaIndex;
    const status = isDone ? "已完成" : isCur ? "进行中" : "未进行";
    lines.push(`### 议题 ${idx + 1}：${item.title}　【${status}】`);
    lines.push("");
    lines.push(`- 目标：${item.goal}`);
    lines.push(`- 计划用时：${item.durationMinutes} 分钟`);
    if (item.processId) lines.push(`- 关联流程：${item.processId}`);
    lines.push(`- 前置材料（提前 24 小时下发）：${item.preReadRef || "无"}`);
    lines.push(`- 讨论要点：（待记录人补充）`);

    const own = decisions.filter((d) => d.agendaTitle === item.title);
    if (own.length) {
      lines.push(`- 本议题决议：${own.map((d) => d.decision).join("；")}`);
    }
    lines.push("");
  });

  lines.push("## 四、决议事项");
  lines.push("");
  lines.push(
    `共 ${decisions.length} 条，其中四要素齐全 ${completeCount} 条${
      decisions.length - completeCount > 0
        ? `，要素不全 ${decisions.length - completeCount} 条（须于会后 2 个工作日内补齐）`
        : ""
    }。`
  );
  lines.push("");
  if (decisions.length === 0) {
    lines.push("（本次会议未形成明确决议）");
  } else {
    decisions.forEach((d, i) => {
      lines.push(decisionBlock(d, i + 1));
      lines.push("");
    });
  }
  lines.push("");

  lines.push("## 五、未决事项与升级路径");
  lines.push("");
  if (openItems.length === 0) {
    lines.push("（无未决事项）");
  } else {
    openItems.forEach((o, i) => {
      lines.push(openItemBlock(o, i + 1));
      lines.push("");
    });
  }
  lines.push("");
  lines.push(
    `> 本会默认升级路径：${config.escalationPath || "提请总经理签批并留档"}`
  );
  lines.push("");

  lines.push("## 六、下次会议");
  lines.push("");
  lines.push("- 时间：（待定）");
  lines.push("- 预定议题：（含本次未决事项的复盘）");
  lines.push("");

  lines.push("## 七、回执确认");
  lines.push("");
  lines.push(
    "本纪要发出后，请各参会人于 **1 个工作日内回执确认**。逾期未回执视为已知悉，但不免除决议责任。"
  );
  lines.push("");
  lines.push("| 参会人 | 部门 | 是否确认 | 回执日期 | 异议或补充 |");
  lines.push("|---|---|---|---|---|");
  const roster = config.attendees.filter((a) => a.name.trim() || a.role.trim());
  if (roster.length === 0) {
    lines.push("| （待填写） |  |  |  |  |");
  } else {
    roster.forEach((a) => {
      lines.push(
        `| ${a.name.trim() || a.role.trim()} | ${a.dept.trim() || ""} |  |  |  |`
      );
    });
  }
  lines.push("");

  return lines.join("\n");
}

/** 供文件下载使用的安全文件名 */
export function minutesFileName(config: MeetingConfig, now = new Date()): string {
  const pad = (n: number) => n.toString().padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const safeTopic = config.topic.replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 40);
  return `会议纪要_${safeTopic}_${stamp}.md`;
}
