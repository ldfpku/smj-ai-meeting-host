/**
 * BICO 泥浆马达 · 中英术语与受控文档索引
 *
 * 来源（摘录日期 2026-09-08）：
 *  - D:\smj-tec-docs\knowledge\90-元\术语表.md
 *    该表在技术知识库中被声明为「译名的唯一权威来源」，此处照录，不自行增删译名。
 *  - 受控文档编号取自 D:\smj-tec-docs\en\ 与 knowledge\10-源文档\
 *
 * 用途：让会议主持人正确识别语音转写中的专业术语（避免把「差压」听成「插压」、
 * 把 SQN-33 听成无意义串），并在决议中挂上正确的部件与文档编号。
 */

export interface GlossaryEntry {
  zh: string;
  en: string;
  note?: string;
}

export interface GlossarySection {
  title: string;
  entries: GlossaryEntry[];
}

export const SMJ_GLOSSARY: GlossarySection[] = [
  {
    title: "马达与总成",
    entries: [
      { zh: "泥浆马达 / 钻井马达", en: "Drilling Mud Motor", note: "BICO G2 系列井下动力钻具" },
      { zh: "动力段", en: "Power Section", note: "定子+转子组成，产生扭矩" },
      { zh: "定子", en: "Stator", note: "内衬弹性体的外筒" },
      { zh: "转子", en: "Rotor", note: "与定子啮合的螺杆" },
      { zh: "弹性体", en: "Elastomer", note: "定子内衬橡胶，受温度/化学侵蚀" },
      { zh: "传动轴 / 传动段", en: "Driveshaft / Transmission" },
      { zh: "轴承总成", en: "Bearing Assembly", note: "承受轴向/径向载荷" },
      { zh: "径向轴承", en: "Radial Bearing", note: "分上/下径向轴承" },
      { zh: "挠性轴", en: "Flexshaft" },
      { zh: "爪式轴", en: "Clawshaft" },
      { zh: "弯角（固定/可调）", en: "Bend Angle (Fixed / Adjustable)", note: "决定造斜能力" },
    ],
  },
  {
    title: "限值与工况",
    entries: [
      { zh: "最大操作限值", en: "Maximum Operating Limits", note: "ENG-004 规定" },
      { zh: "差压", en: "Differential Pressure", note: "与失速及动力段可靠性强相关" },
      { zh: "失速差压", en: "Stall Differential Pressure" },
      { zh: "钻压", en: "Weight On Bit (WOB)", note: "与轴承总成可靠性强相关" },
      { zh: "转速", en: "Rotary Speed (RPM)" },
      { zh: "井底温度", en: "Bottomhole Temperature (BHT)", note: "高温致弹性体膨胀→定子早期失效" },
      { zh: "降额", en: "Derating", note: "高温下按安全系数下调差压" },
      { zh: "超规操作", en: "Out of Specification (OOS)", note: "逾越 ENG-004 限值" },
      { zh: "扭断", en: "Twist-off" },
    ],
  },
  {
    title: "配合与磨损",
    entries: [
      { zh: "动力段配合", en: "Power Section Fit", note: "SQN-33 限 +0.020\"" },
      { zh: "定子小径", en: "Stator Minor ID", note: "磨损上限 +0.020\"（SQN-33）" },
      { zh: "转子谷径外径", en: "Rotor VtC OD", note: "磨损上限 −0.010\"（SQN-33）" },
      { zh: "径向轴承配合", en: "Radial Bearing Fit / Gap", note: "SQN-31 限值" },
      { zh: "轴向游隙", en: "Axial Play / Bearing Play", note: "复用基线测量（ENG-001）" },
      { zh: "顶推/回拉测量", en: "Push/Pull Measurement" },
    ],
  },
  {
    title: "维修·检验·材料",
    entries: [
      { zh: "复用标准", en: "Re-run Criteria", note: "ENG-001" },
      { zh: "螺纹锁固剂", en: "Thread-Locking Compound", note: "TORQ-LOK / Motoloc（OPS-EH-002）" },
      { zh: "铜基防粘剂", en: "KOPR-KOTE", note: "涂于台肩" },
      { zh: "无损检测", en: "NDT", note: "ENG-008" },
      { zh: "HVOF 涂层", en: "HVOF Coating", note: "高速氧焰喷涂（BICO 10003）" },
      { zh: "定子重衬", en: "Stator Relining" },
      { zh: "硫化物应力开裂", en: "Sulfide Stress Cracking (SSC)" },
      { zh: "应力腐蚀开裂", en: "Stress Corrosion Cracking (SCC)" },
      { zh: "疲劳", en: "Fatigue" },
      { zh: "裂盒 / 胀盒", en: "Split Box / Belled Box", note: "扭转失效表观" },
    ],
  },
  {
    title: "文档体系",
    entries: [
      { zh: "受控文档", en: "Controlled Document", note: "电子版为唯一受控版本" },
      { zh: "修订", en: "Revision (Rev)" },
      { zh: "服务质量通告", en: "Service Quality Notice (SQN)", note: "现场规格变更通告" },
      { zh: "现场警报", en: "Field Alert", note: "SQN 的来源事件" },
    ],
  },
];

/** 受控文档编号索引：会上提到这些编号时，主持人应准确复述而非听写成近音字 */
export const SMJ_CONTROLLED_DOCS: { id: string; title: string }[] = [
  { id: "ENG-001", title: "马达复用标准 (Motor Re-run Criteria)" },
  { id: "ENG-003", title: "G2 服务手册 (G2 Service Manual)" },
  { id: "ENG-004", title: "最大操作限值 (Max Operating Limits, Rev 2)" },
  { id: "ENG-008", title: "无损检测规程 (NDT Inspection Procedure)" },
  { id: "ENG-PRO-002", title: "涂层转子接头焊接 (WCRS)" },
  { id: "ENG-DOC-1001", title: "动力段存储与维修要求" },
  { id: "SQN-31", title: "径向轴承限值" },
  { id: "SQN-33", title: "动力段磨损限值" },
  { id: "OPS-EH-002", title: "螺纹锁固剂" },
  { id: "BICO 10003", title: "HVOF 涂层规范" },
  { id: "MAT-006", title: "17-4 PH 不锈钢材料标准" },
];

/** 紧凑术语参考，供拼入主持人提示词的「参考资料」段 */
export function buildGlossaryReference(): string {
  const terms = SMJ_GLOSSARY.map(
    (s) => `${s.title}：` + s.entries.map((e) => `${e.zh}(${e.en})`).join("、")
  ).join("\n");

  const docs = SMJ_CONTROLLED_DOCS.map((d) => `${d.id} ${d.title}`).join("； ");

  return [
    "### 专业术语（中英对照，用于正确听辨与复述）",
    terms,
    "",
    "### 受控文档编号",
    docs,
  ].join("\n");
}
