/**
 * SMJ 组织与流程接地数据
 *
 * 来源（摘录日期 2026-09-08，均为只读引用，本仓库不在运行时读取这些路径）：
 *  - 部门与定位：D:\smj-manage\SMJ组织架构_v1.md
 *                D:\smj-manage\202608\SMJ部门职责与岗位职责汇编.md
 *  - 岗位清单：  D:\smj-manage\202608\岗位职责说明书\（51 份，文件名即「<部门>-<岗位>岗位职责说明书.md」）
 *  - 流程清单：  D:\smj-manage\202608\业务流程\00-流程总览与修订说明.md（35 条，含归口部门）
 *
 * 语料更新时需人工复核本文件。此处只保留部门名、岗位名与流程编号，
 * 不包含任何人员姓名、绩效或性格测评数据。
 */

export interface SmjDepartment {
  id: string;
  name: string;
  kind: "business" | "support" | "virtual" | "exec";
  mission: string;
}

export interface SmjRole {
  title: string;
  dept: string;
}

export interface SmjProcess {
  id: string;
  name: string;
  ownerDept: string;
}

/** 总经理 + 8 个一级部门 + 1 个虚拟专项组 */
export const SMJ_DEPARTMENTS: SmjDepartment[] = [
  { id: "GM", name: "总经理", kind: "exec", mission: "安全生产第一责任人；产销租协同会、技术评审组、绩效评议组召集人；未决事项最终签批" },
  { id: "MKT", name: "市场商务部", kind: "business", mission: "收入与客户界面中心：中海油组/石油石化组/国际组/商务组；投标、价格管理、合同评审组织、结算对账与回款" },
  { id: "OPS", name: "运营管理部", kind: "business", mission: "利润主轴与交付中心：租赁运营与工具资产台账（一物一码）、四个维保基地（天津/成都/新疆/惠州）、维保技术支持" },
  { id: "MFG", name: "生产制造部", kind: "business", mission: "交付与产能中心：PMC 统排两车间、装配组、设备动力组、螺杆产能建设" },
  { id: "SCM", name: "供应链部", kind: "business", mission: "成本与供应保障中心：战略采购与进口关务、供应商管理、外协商务、仓储物流与下料" },
  { id: "TEC", name: "技术研发部", kind: "business", mission: "技术中枢：产品线管理与设计、工艺技术、技术档案（BOM/图纸/程序/MES 主数据）、BICO 技术转化牵头" },
  { id: "QHSE", name: "质量安全部", kind: "support", mission: "质量与安全独立监督线：体系与文件控制归口、各级检验与放行、MRB 与让步接收、8D 归零、HSE 与计量" },
  { id: "FIN", name: "财务部", kind: "support", mission: "核算＋管理型财务：成本与定价口径、预算与月度经营分析、资金与信用、租赁资产账务" },
  { id: "ADM", name: "综合管理部", kind: "support", mission: "组织运转基础平台：人力资源、行政后勤（会议纪要编制）、法务合规、信息化" },
  { id: "PROJ", name: "螺杆产业化专项组", kind: "virtual", mission: "虚拟项目组，总经理挂帅，跨部门推进螺杆自有产能释放（2026-12 达产后解散）；按周例会直报总经理" },
];

/** 51 个岗位（与岗位职责说明书一一对应），另加总经理 */
export const SMJ_ROLES: SmjRole[] = [
  { title: "总经理", dept: "总经理" },

  { title: "市场商务部部长", dept: "市场商务部" },
  { title: "中海油大客户经理", dept: "市场商务部" },
  { title: "中海油客户专员", dept: "市场商务部" },
  { title: "石油石化客户经理", dept: "市场商务部" },
  { title: "国际油服客户经理", dept: "市场商务部" },
  { title: "国际业务经理", dept: "市场商务部" },
  { title: "投标与价格专员", dept: "市场商务部" },
  { title: "结算专员", dept: "市场商务部" },

  { title: "运营管理部部长", dept: "运营管理部" },
  { title: "租赁运营专员", dept: "运营管理部" },
  { title: "维保技术工程师", dept: "运营管理部" },
  { title: "维保基地主管", dept: "运营管理部" },
  { title: "维保技工", dept: "运营管理部" },
  { title: "基地库管员", dept: "运营管理部" },

  { title: "生产制造部部长", dept: "生产制造部" },
  { title: "生产计划员", dept: "生产制造部" },
  { title: "车间主任", dept: "生产制造部" },
  { title: "生产班组长", dept: "生产制造部" },
  { title: "机加操作工", dept: "生产制造部" },
  { title: "表面工艺操作工", dept: "生产制造部" },
  { title: "装配试验工", dept: "生产制造部" },
  { title: "设备动力管理员", dept: "生产制造部" },

  { title: "供应链部部长", dept: "供应链部" },
  { title: "战略采购与进口关务专员", dept: "供应链部" },
  { title: "订单采购专员", dept: "供应链部" },
  { title: "库房管理员", dept: "供应链部" },
  { title: "下料工", dept: "供应链部" },
  { title: "发运协调员", dept: "供应链部" },

  { title: "技术研发部部长", dept: "技术研发部" },
  { title: "产品线经理", dept: "技术研发部" },
  { title: "工艺工程师", dept: "技术研发部" },
  { title: "车间工艺员", dept: "技术研发部" },
  { title: "数控程序员", dept: "技术研发部" },
  { title: "制图员", dept: "技术研发部" },
  { title: "技术档案员", dept: "技术研发部" },

  { title: "质量安全部部长", dept: "质量安全部" },
  { title: "体系工程师", dept: "质量安全部" },
  { title: "售后质量工程师", dept: "质量安全部" },
  { title: "工厂检验员", dept: "质量安全部" },
  { title: "基地质检员", dept: "质量安全部" },
  { title: "计量员", dept: "质量安全部" },
  { title: "HSE专员", dept: "质量安全部" },

  { title: "财务部长", dept: "财务部" },
  { title: "总账税务会计", dept: "财务部" },
  { title: "成本会计", dept: "财务部" },
  { title: "往来会计", dept: "财务部" },
  { title: "出纳", dept: "财务部" },

  { title: "综合管理部部长", dept: "综合管理部" },
  { title: "人力资源专员", dept: "综合管理部" },
  { title: "行政后勤专员", dept: "综合管理部" },
  { title: "信息化专员", dept: "综合管理部" },
];

/** 35 条业务流程（业务流程手册 V2.0） */
export const SMJ_PROCESSES: SmjProcess[] = [
  { id: "M-01", name: "投标与报价流程", ownerDept: "市场商务部" },
  { id: "M-02", name: "合同评审与签订流程", ownerDept: "市场商务部" },
  { id: "M-03", name: "销售业务跟单流程", ownerDept: "市场商务部" },
  { id: "M-04", name: "租赁业务跟单与三层对账流程", ownerDept: "市场商务部" },

  { id: "O-01", name: "租赁发运与起止租确认流程", ownerDept: "运营管理部" },
  { id: "O-02", name: "跨基地工具调配流程", ownerDept: "运营管理部" },
  { id: "O-03", name: "工具维保流程", ownerDept: "运营管理部" },
  { id: "O-04", name: "基地返修流程", ownerDept: "运营管理部" },

  { id: "P-01", name: "生产计划制定与产销租协同流程", ownerDept: "生产制造部" },
  { id: "P-02", name: "外协加工流程", ownerDept: "生产制造部" },
  { id: "P-03", name: "返厂大修流程", ownerDept: "生产制造部" },

  { id: "S-01", name: "采购流程", ownerDept: "供应链部" },
  { id: "S-02", name: "入库流程", ownerDept: "供应链部" },
  { id: "S-03", name: "领用出库流程", ownerDept: "供应链部" },
  { id: "S-04", name: "发货出库流程", ownerDept: "供应链部" },
  { id: "S-05", name: "下料流程", ownerDept: "供应链部" },

  { id: "T-01", name: "工艺管理流程", ownerDept: "技术研发部" },
  { id: "T-02", name: "技术改进与技术转化流程", ownerDept: "技术研发部" },
  { id: "T-03", name: "技术变更（ECN）与受控文件流程", ownerDept: "技术研发部" },

  { id: "Q-01", name: "质量管理流程", ownerDept: "质量安全部" },
  { id: "Q-02", name: "产品检验流程", ownerDept: "质量安全部" },
  { id: "Q-03", name: "失效分析与质量归零（8D）流程", ownerDept: "质量安全部" },
  { id: "Q-04", name: "安全管理流程", ownerDept: "质量安全部" },

  { id: "E-01", name: "设备点检流程", ownerDept: "生产制造部" },
  { id: "E-02", name: "设备保养流程", ownerDept: "生产制造部" },
  { id: "E-03", name: "设备维修流程", ownerDept: "生产制造部" },

  { id: "F-01", name: "年度预算编制流程", ownerDept: "财务部" },
  { id: "F-02", name: "存货与工具盘点流程", ownerDept: "财务部" },
  { id: "F-03", name: "固定资产管理流程", ownerDept: "财务部" },

  { id: "H-01", name: "招聘流程", ownerDept: "综合管理部" },
  { id: "H-02", name: "新员工入职流程", ownerDept: "综合管理部" },
  { id: "H-03", name: "培训管理流程", ownerDept: "综合管理部" },
  { id: "H-04", name: "绩效管理流程", ownerDept: "综合管理部" },
  { id: "H-05", name: "跨部门人员调动流程", ownerDept: "综合管理部" },
  { id: "H-06", name: "部门内岗位调整流程", ownerDept: "综合管理部" },
];

/** 公司业务速览，供主持人理解讨论内容所处的业务背景 */
export const SMJ_BUSINESS_BRIEF = [
  "SMJ 为石油钻井井下工具的制造商、租赁商与维保商。",
  "产品线：震击器系（震击器/加速器/减震器）、螺杆系（螺杆马达/水力震荡器）、开窗工具。",
  "经营模式：制造 + 租赁运营（工具池一物一码动态台账）+ 维保返厂大修。",
  "主要客户：中海油、中石油、贝克休斯、斯伦贝谢。",
  "战略主线：消化吸收 BICO（SBO 集团）授权的螺杆马达技术，由螺杆产业化专项组推进 2026-12 达产。",
].join("\n");

export const SMJ_DEPARTMENT_NAMES = SMJ_DEPARTMENTS.map((d) => d.name);

export function getRolesByDept(dept: string): SmjRole[] {
  return SMJ_ROLES.filter((r) => r.dept === dept);
}

export function findProcess(id: string): SmjProcess | undefined {
  const key = id.trim().toUpperCase();
  return SMJ_PROCESSES.find((p) => p.id === key);
}

/** 紧凑的组织与流程索引，供拼入主持人提示词的「参考资料」段 */
export function buildOrgReference(): string {
  const depts = SMJ_DEPARTMENTS.filter((d) => d.kind !== "exec")
    .map((d) => `- ${d.name}：${d.mission}`)
    .join("\n");

  const processes = SMJ_PROCESSES.map((p) => `${p.id} ${p.name}（${p.ownerDept}）`).join(
    "； "
  );

  return [
    "### 部门与归口",
    depts,
    "",
    "### 业务流程编号索引（用于把决议挂到既有流程上）",
    processes,
  ].join("\n");
}
