/**
 * SMJ 会议模板库
 *
 * 固定议题逐字取自业务流程手册，不自行编造。每个模板都标注了出处，便于追溯核对。
 * 来源（摘录日期 2026-09-08）：
 *  - D:\smj-manage\202608\业务流程\03-生产制造流程.md:101,109   （P-01 月度产销租协同会）
 *  - D:\smj-manage\202608\业务流程\08-财务管理流程.md:94        （F-01 月度经营分析会）
 *  - D:\smj-manage\202608\业务流程\06-质量与HSE流程.md:108-109,191,197（MRB / 8D）
 *  - D:\smj-manage\202608\业务流程\00-流程总览与修订说明.md      （技术评审组）
 *  - D:\smj-manage\技术研发部职能_v2.md                          （BICO 一期转化排期）
 *  - D:\smj-manage\202608\部门负责人任职匹配鉴定与建议.md:398    （专项组按周例会，直报总经理）
 *  - D:\smj-manage\advices\技术消化吸收与再创新.md               （阶段门五种结论）
 *
 * 类型为 import type，编译期擦除，不与 ./meeting 形成运行时循环依赖。
 */
import type { AgendaItem, Attendee, MeetingConfig, MeetingStyle } from "./meeting";

export interface MeetingTemplate {
  id: string;
  name: string;
  meetingType: string;
  cadence: string;
  /** 主持岗位 */
  chair: string;
  /** 应参会的部门或岗位，进入配置弹窗后由组织者填写具体姓名 */
  expectedRoles: string[];
  /** 未决事项的升级路径 */
  escalationPath: string;
  /** 是否要求 24 小时书面前置材料 */
  requirePreRead: boolean;
  style: MeetingStyle;
  /** 出处，展示在配置弹窗中以便追溯 */
  source: string;
  agendas: Omit<AgendaItem, "id">[];
}

export const MEETING_TEMPLATES: MeetingTemplate[] = [
  {
    id: "prod-sales-rent-sync",
    name: "月度产销租协同会",
    meetingType: "月度例会",
    cadence: "每月一次",
    chair: "总经理",
    expectedRoles: [
      "市场商务部部长",
      "运营管理部部长",
      "生产制造部部长",
      "供应链部部长",
      "技术研发部部长",
      "生产计划员",
    ],
    escalationPath: "优先级冲突由本会裁决；会中未决的临时插单由总经理签批，PMC 留档",
    requirePreRead: true,
    style: "strict",
    source: "业务流程手册 P-01（03-生产制造流程.md:101,109）",
    agendas: [
      {
        title: "上月完成率",
        durationMinutes: 10,
        goal: "确认上月生产经营计划完成情况与偏差原因",
        processId: "P-01",
        preReadRef: "上月生产统计（产量/工时/一次交验合格率）",
      },
      {
        title: "四类需求满足率",
        durationMinutes: 15,
        goal: "确认销售订单／租赁池补充／备件／返厂大修四类需求的满足情况",
        processId: "P-01",
        preReadRef: "四类需求合一台账",
      },
      {
        title: "瓶颈工序",
        durationMinutes: 10,
        goal: "识别当期瓶颈工序并明确疏通措施与责任人",
        processId: "P-01",
      },
      {
        title: "下月优先级排序",
        durationMinutes: 15,
        goal: "裁决四类需求的排产优先级冲突，形成下月排产依据",
        processId: "P-01",
        preReadRef: "下月需求汇总与产能测算",
      },
      {
        title: "达产里程碑进度",
        durationMinutes: 10,
        goal: "确认螺杆产线达产里程碑进度，暴露延误并定预警",
        processId: "P-01",
      },
    ],
  },
  {
    id: "monthly-business-review",
    name: "月度经营分析会",
    meetingType: "月度例会",
    cadence: "每月一次（2026Q4 起）",
    chair: "财务部长",
    expectedRoles: [
      "总经理",
      "财务部长",
      "市场商务部部长",
      "运营管理部部长",
      "生产制造部部长",
      "供应链部部长",
      "技术研发部部长",
      "质量安全部部长",
      "综合管理部部长",
    ],
    escalationPath: "指标缺口与资源冲突提请总经理裁决",
    requirePreRead: true,
    style: "strict",
    source: "业务流程手册 F-01（08-财务管理流程.md:94）；三张表口径见财务部职能_v2",
    agendas: [
      {
        title: "收入与毛利达成",
        durationMinutes: 15,
        goal: "对照预算确认收入与毛利达成，明确缺口补救措施",
        processId: "F-01",
        preReadRef: "毛利表（分产品线）",
      },
      {
        title: "四类需求满足",
        durationMinutes: 10,
        goal: "从经营口径复核四类需求满足情况",
        processId: "F-01",
      },
      {
        title: "应收账龄（中石油单列）",
        durationMinutes: 15,
        goal: "确认账龄变化与逾期，明确催款责任人与时限",
        processId: "F-01",
        preReadRef: "账龄表（分客户，中石油单列）",
      },
      {
        title: "库存与资金占用",
        durationMinutes: 10,
        goal: "确认库存与租赁资产周转，压降资金占用",
        processId: "F-02",
        preReadRef: "库存与租赁资产周转表",
      },
      {
        title: "达产里程碑",
        durationMinutes: 10,
        goal: "确认达产里程碑对预算与增编释放的影响",
        processId: "F-01",
      },
    ],
  },
  {
    id: "pdm-taskforce-weekly",
    name: "螺杆产业化专项组周例会",
    meetingType: "专项周例会",
    cadence: "每周一次（直报总经理，不受部门层级阻隔）",
    chair: "总经理",
    expectedRoles: [
      "总经理",
      "技术研发部部长",
      "产品线经理",
      "生产制造部部长",
      "车间主任",
      "供应链部部长",
      "质量安全部部长",
    ],
    escalationPath: "任一环节延误 2 周即向总经理预警；进度纳入专项组月度督办",
    requirePreRead: false,
    style: "strict",
    source: "技术研发部职能_v2.md（BICO 一期转化排期）；部长任职鉴定:398",
    agendas: [
      {
        title: "图纸英公制转换与受控入档进度",
        durationMinutes: 10,
        goal: "确认 64 份图纸转换与入档进度，暴露卡点",
        processId: "T-03",
      },
      {
        title: "工艺规程编制与 MES 工艺路线录入",
        durationMinutes: 10,
        goal: "确认 32 条工艺规程与 MES 路线录入进度",
        processId: "T-01",
      },
      {
        title: "首件试制与工艺验证",
        durationMinutes: 15,
        goal: "确认首件试制状态与 QHSE 首件鉴定结论",
        processId: "Q-02",
      },
      {
        title: "供应链切换与长周期料",
        durationMinutes: 10,
        goal: "确认螺杆供应链切换与棒料长周期订货是否卡住节点",
        processId: "S-01",
      },
      {
        title: "达产里程碑偏差与预警",
        durationMinutes: 10,
        goal: "逐项核对里程碑，对延误 2 周以上的环节当场定预警与补救",
      },
    ],
  },
  {
    id: "mrb-review",
    name: "MRB 不合格品评审",
    meetingType: "事件触发评审",
    cadence: "按事件（QHSE 召集）",
    chair: "质量安全部部长",
    expectedRoles: [
      "质量安全部部长",
      "工厂检验员",
      "产品线经理",
      "工艺工程师",
      "车间主任",
      "生产制造部部长",
    ],
    escalationPath:
      "让步接收须技术／质量／生产三方会签；同一缺陷同一部件让步 2 次即强制升级为 T-03 技术变更或 T-02 改进项目",
    requirePreRead: false,
    style: "strict",
    source: "业务流程手册 Q-02（06-质量与HSE流程.md:108-109,191）",
    agendas: [
      {
        title: "不合格事实陈述",
        durationMinutes: 10,
        goal: "由生产提供事实（批次、数量、工序、检验记录），不作判定",
        processId: "Q-02",
      },
      {
        title: "技术结论与判定依据",
        durationMinutes: 15,
        goal: "由技术研发部给出技术结论与判定依据（含特殊过程参数）",
        processId: "Q-02",
      },
      {
        title: "处置判定：返修／让步接收／报废",
        durationMinutes: 15,
        goal: "形成处置结论；报废须记录责任归属（料/工/法/环/测）",
        processId: "Q-02",
      },
      {
        title: "让步接收的限批次、限范围、限次数",
        durationMinutes: 10,
        goal: "若判定让步接收，当场明确三限并登记让步接收台账",
        processId: "Q-02",
      },
    ],
  },
  {
    id: "tech-review-board",
    name: "技术评审组",
    meetingType: "非常设项目评审",
    cadence: "按项目（总经理召集）",
    chair: "总经理",
    expectedRoles: [
      "总经理",
      "技术研发部部长",
      "产品线经理",
      "生产制造部部长",
      "质量安全部部长",
      "运营管理部部长",
      "财务部长",
    ],
    escalationPath: "阶段结论五选一：通过／附条件通过／整改后复审／暂停／终止，由总经理签批",
    requirePreRead: true,
    style: "gentle",
    source: "业务流程手册 00-流程总览；阶段门结论见 advices/技术消化吸收与再创新.md",
    agendas: [
      {
        title: "方案与技术路线",
        durationMinutes: 20,
        goal: "由技术研发部说明方案、技术路线与验证情况",
        processId: "T-02",
        preReadRef: "技术方案与试验数据（提前 24 小时下发）",
      },
      {
        title: "工艺与产能可行性",
        durationMinutes: 15,
        goal: "生产制造部就工艺可实现性与产能影响出具意见",
        processId: "T-01",
      },
      {
        title: "质量与认证影响",
        durationMinutes: 10,
        goal: "质量安全部就 API 7-2／Q1 体系与特殊过程影响出具意见",
        processId: "Q-01",
      },
      {
        title: "成本与投资",
        durationMinutes: 10,
        goal: "财务部就成本口径与投资回收出具意见",
        processId: "F-01",
      },
      {
        title: "阶段结论",
        durationMinutes: 10,
        goal: "形成五选一阶段门结论并明确附加条件与复审时点",
        processId: "T-02",
      },
    ],
  },
  {
    id: "quality-8d",
    name: "失效分析与质量归零（8D）",
    meetingType: "事件触发归零",
    cadence: "按事件",
    chair: "质量安全部部长",
    expectedRoles: [
      "质量安全部部长",
      "售后质量工程师",
      "产品线经理",
      "工艺工程师",
      "维保技术工程师",
      "车间主任",
    ],
    escalationPath: "纠正措施有效性验证与举一反三纳入管理评审输入",
    requirePreRead: false,
    style: "strict",
    source: "业务流程手册 Q-03（06-质量与HSE流程.md:197）",
    agendas: [
      {
        title: "D1–D2 小组组建与问题描述",
        durationMinutes: 10,
        goal: "明确归零小组与问题的量化描述",
        processId: "Q-03",
      },
      {
        title: "D3 临时遏制措施",
        durationMinutes: 10,
        goal: "确定遏制范围（在制、在库、在租、已交付）与执行责任人",
        processId: "Q-03",
      },
      {
        title: "D4 根本原因分析",
        durationMinutes: 20,
        goal: "定位根因（含失效机理判定），形成可验证的因果链",
        processId: "Q-03",
      },
      {
        title: "D5–D6 纠正措施与验证",
        durationMinutes: 15,
        goal: "确定纠正措施、验证方式与关闭证据",
        processId: "Q-03",
      },
      {
        title: "D7–D8 举一反三与固化",
        durationMinutes: 10,
        goal: "明确横向排查范围与文件固化（工艺规程／检验标准／ECN）",
        processId: "Q-03",
      },
    ],
  },
  {
    id: "base-weekly-safety",
    name: "基地每周安全会议",
    meetingType: "周例会",
    cadence: "每周一次（基地主管为 HSE 属地第一责任人）",
    chair: "维保基地主管",
    expectedRoles: ["维保基地主管", "HSE专员", "基地质检员", "维保技工", "基地库管员"],
    escalationPath: "关键隐患整改不闭环的，上报质量安全部并抄送总经理",
    requirePreRead: false,
    style: "gentle",
    source: "业务流程手册 Q-04；质量安全部-HSE专员岗位职责说明书",
    agendas: [
      {
        title: "上周隐患整改闭环情况",
        durationMinutes: 10,
        goal: "逐条确认隐患整改与验证结果，未闭环的定责任人与时限",
        processId: "Q-04",
      },
      {
        title: "本周作业风险辨识",
        durationMinutes: 10,
        goal: "识别本周维保作业的主要风险并明确管控措施",
        processId: "Q-04",
      },
      {
        title: "特种设备与应急演练",
        durationMinutes: 10,
        goal: "确认特种设备状态与应急演练安排",
        processId: "Q-04",
      },
    ],
  },
];

let seq = 0;
function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}`;
}

/** 把模板展开为一份可编辑的会议配置；参会人姓名留空，由组织者填写 */
export function templateToConfig(template: MeetingTemplate): MeetingConfig {
  const agendas: AgendaItem[] = template.agendas.map((a, i) => ({
    ...a,
    id: `agenda-${template.id}-${i + 1}`,
  }));

  const attendees: Attendee[] = template.expectedRoles.map((role, i) => ({
    id: `att-${template.id}-${i + 1}`,
    name: "",
    dept: "",
    role,
    required: true,
  }));

  return {
    templateId: template.id,
    meetingType: template.meetingType,
    topic: template.name,
    chair: template.chair,
    totalDurationMinutes: agendas.reduce((s, a) => s + a.durationMinutes, 0),
    agendas,
    attendees,
    style: template.style,
    requirePreRead: template.requirePreRead,
    escalationPath: template.escalationPath,
  };
}

export function findTemplate(id: string | undefined): MeetingTemplate | undefined {
  if (!id) return undefined;
  return MEETING_TEMPLATES.find((t) => t.id === id);
}

/** 新建空白议题时使用 */
export function makeBlankAgenda(index: number): AgendaItem {
  return {
    id: nextId("agenda-custom"),
    title: `新议题 ${index}`,
    durationMinutes: 10,
    goal: "明确决议与下一步",
  };
}

export function makeBlankAttendee(): Attendee {
  return {
    id: nextId("att-custom"),
    name: "",
    dept: "",
    role: "",
    required: false,
  };
}
