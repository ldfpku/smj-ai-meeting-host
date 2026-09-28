import type { MeetingConfig } from "./meeting";

/**
 * 演示会议：由合成语音扮演四位参会人，自动开完一场几分钟的会。
 *
 * 用途有两个：给没用过的人看主持人怎么工作；改了提示词、工具或模型之后，
 * 在真实页面上走一遍全流程，看有没有出问题。
 *
 * 台词里安排了主持人应当处理的几种情况：闲聊跑题、决议缺要素、
 * 定不下来的事项、点名表态、要求推进议题、要求总结。
 */

export interface DemoStep {
  id: string;
  /** 参会人姓名，对应 DEMO_VOICES */
  say: string;
  text: string;
  /** 这一步想看主持人的什么反应，显示在演示面板上 */
  watch: string;
  /** reply：说完后等主持人说完再继续；next：紧接着下一位发言 */
  then: "reply" | "next";
  /** interrupt：这段话是跑题，主持人应当打断；被打断后发言人停下 */
  expect?: "interrupt";
  /** advance：这一步之后议程应当推进；没有推进就用 retry 再说一次 */
  until?: "advance";
  retry?: string;
}

export const DEMO_CONFIG: MeetingConfig = {
  topic: "螺杆钻具交付专题会",
  meetingType: "专题会（演示）",
  chair: "生产制造部部长",
  totalDurationMinutes: 6,
  style: "strict",
  escalationPath: "提请总经理签批并留档",
  requirePreRead: false,
  attendees: [
    { id: "demo-wang", name: "王部长", dept: "生产制造部", role: "部长", required: true },
    { id: "demo-li", name: "李部长", dept: "技术研发部", role: "部长", required: true },
    { id: "demo-zhao", name: "赵部长", dept: "市场商务部", role: "部长", required: false },
    { id: "demo-chen", name: "陈部长", dept: "供应链部", role: "部长", required: false },
  ],
  agendas: [
    {
      id: "demo-a1",
      title: "定子硫化工序瓶颈",
      durationMinutes: 4,
      goal: "确定硫化工序的疏通措施和责任人",
      presenter: "王部长",
    },
    {
      id: "demo-a2",
      title: "下月交付优先级",
      durationMinutes: 2,
      goal: "确定两个订单的排产先后",
      presenter: "赵部长",
    },
  ],
  intervention: {
    mode: "auto",
    threshold: 0.85,
    cooldownSeconds: 45,
    consecutiveHits: 1,
  },
};

/** 每位参会人一种音色，听得出是不同的人 */
export const DEMO_VOICES: Record<string, string> = {
  王部长: "Charon",
  李部长: "Orus",
  赵部长: "Kore",
  陈部长: "Puck",
};

/** 被主持人点名表态时的回答，按议题区分 */
export const DEMO_ANSWERS: Record<string, Record<string, string>> = {
  "demo-a1": {
    王部长: "我同意这个方案，没有不同意见。",
    李部长: "我同意，十月二十日之前我把模具改完。",
  },
  "demo-a2": {
    王部长: "我同意先记为未决事项，没有其他意见。",
    李部长: "我也同意，没有意见。",
  },
};
export const DEMO_DEFAULT_ANSWER = "我同意，没有不同意见。";

export const DEMO_STEPS: DemoStep[] = [
  {
    id: "problem",
    say: "王部长",
    text: "我先说一下情况。硫化罐只有一台，上个月定子硫化平均要排队三天，整条螺杆线都被它拖慢了，这是现在最大的瓶颈。",
    watch: "正常发言，主持人应保持安静",
    then: "next",
  },
  {
    id: "cause",
    say: "李部长",
    text: "我们算过，把硫化模具从一模一件改成一模两件，单罐产能可以提高百分之八十，模具改造大概需要两周。",
    watch: "正常发言，主持人应保持安静",
    then: "reply",
  },
  {
    id: "off_topic",
    say: "陈部长",
    text: "说到这个，下个月公司团建大家想去哪里啊？我觉得去海边不错，可以吃海鲜，上次那家餐厅的螃蟹特别好吃。对了，你们看昨天晚上的球赛了吗，最后那个进球太精彩了，我到现在还在回味。",
    watch: "闲聊跑题，主持人应在几秒内打断",
    expect: "interrupt",
    then: "reply",
  },
  {
    id: "proposal",
    say: "赵部长",
    text: "回到硫化的问题。我建议就按李部长说的办，把模具改成一模两件，由技术研发部李部长负责。",
    watch: "方案只说了责任人，主持人应追问时限、验证方式和关闭证据，不应自己编",
    then: "reply",
  },
  {
    id: "complete",
    say: "王部长",
    text: "完成时限定在十月二十日之前。验证方式是改造后连续一周单罐日产量达到十二件，关闭证据是生产制造部出具的周产量报表。",
    watch: "四要素齐全，主持人应记录决议并点名表态",
    then: "reply",
  },
  {
    id: "close_1",
    say: "王部长",
    text: "第一个议题就这样定了，请主持人进入下一个议题。",
    watch: "主持人应推进到第二项，并请赵部长先介绍情况",
    then: "reply",
    until: "advance",
    retry: "请主持人进入下一个议题。",
  },
  {
    id: "plan",
    say: "赵部长",
    text: "下个月有两个订单撞在一起，一个是新疆客户的二十套螺杆，一个是租赁池要补的十五套，产能只够先做一个。",
    watch: "正常发言，主持人应保持安静",
    then: "next",
  },
  {
    id: "blocked",
    say: "陈部长",
    text: "新疆客户的到货期限，他们到现在还没有书面确认，所以先做哪一个今天定不下来。",
    watch: "正常发言，主持人应保持安静",
    then: "next",
  },
  {
    id: "open_item",
    say: "李部长",
    text: "那这一条今天先不定，记为未决事项，由赵部长跟进，周五之前拿到客户的书面确认。",
    watch: "主持人应登记未决事项并说明升级路径",
    then: "reply",
  },
  {
    id: "wrap_up",
    say: "王部长",
    text: "今天的议题都谈完了，请主持人做个总结，然后结束会议。",
    watch: "主持人应汇报决议和未决事项的数量",
    then: "reply",
  },
];
