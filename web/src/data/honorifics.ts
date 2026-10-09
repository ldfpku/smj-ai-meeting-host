/**
 * 会议里怎么称呼人：“李总”“王部长”，没有姓名时退回岗位全称。
 *
 * 在网页里算好，随会议配置一起发给 agent（`callName`、`chairCallName`），
 * agent 里的固定话术直接用，不再另写一套规则。姓名只来自组织者自己填写的名单。
 */

/** 常见复姓；其余按单姓处理 */
const COMPOUND_SURNAMES = [
  "欧阳", "司马", "上官", "诸葛", "慕容", "皇甫", "尉迟", "公孙", "东方",
  "夏侯", "令狐", "长孙", "宇文", "司徒", "轩辕", "独孤", "端木", "南宫",
];

/** 岗位名里带这些词时，对应的称呼后缀；顺序有讲究，长的、更具体的在前 */
const TITLES: [RegExp, string][] = [
  [/(副?总经理|副总|总监|总裁)/, "总"],
  [/(副?部长)/, "部长"],
  [/(副?主管)/, "主管"],
  [/(副?经理)/, "经理"],
  [/(副?主任)/, "主任"],
  [/(副?厂长)/, "厂长"],
  [/(副?科长)/, "科长"],
  [/(工程师)/, "工"],
];

export function surnameOf(name: string): string {
  const n = name.trim();
  if (!n) return "";
  const compound = COMPOUND_SURNAMES.find((s) => n.startsWith(s));
  return compound ?? n.slice(0, 1);
}

/** 岗位对应的称呼后缀（“总”“部长”……）；没有对应的返回 null */
export function titleSuffix(role: string): string | null {
  // 总经理助理、部长秘书这类不是“X总”“X部长”
  if (/(助理|秘书|专员|文员)/.test(role)) return null;
  for (const [pattern, suffix] of TITLES) {
    if (pattern.test(role)) return suffix;
  }
  return null;
}

/**
 * 称呼：有姓名又有对应职务时是“姓 + 职务”（王建国 / 生产制造部部长 → 王部长），
 * 只有姓名时用姓名，只有岗位时用岗位全称，都没有则为空。
 */
export function callNameFor(name: string, role: string): string {
  const n = name.trim();
  const r = role.trim();
  if (n && r) {
    const suffix = titleSuffix(r);
    // 单字名无法确定姓氏是哪一个字，直接用全名
    if (suffix && n.length >= 2) return surnameOf(n) + suffix;
    return n;
  }
  return n || r;
}

interface WithCallNames {
  chair?: string;
  chairName?: string;
  chairCallName?: string;
  attendees: { name: string; role: string; callName?: string }[];
}

/** 给配置里的主持人和参会人补上 callName；不改动原对象 */
export function withCallNames<T extends WithCallNames>(config: T): T {
  const chairRole = config.chair ?? "";
  return {
    ...config,
    chairCallName: callNameFor(config.chairName ?? "", chairRole) || undefined,
    attendees: config.attendees.map((a) => ({
      ...a,
      callName: callNameFor(a.name, a.role) || undefined,
    })),
  };
}
