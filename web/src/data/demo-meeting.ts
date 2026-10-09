import { withCallNames } from "./honorifics";
import type { MeetingConfig } from "./meeting";

/**
 * 演示会议：由合成语音扮演四位参会人，自动开完一场几分钟的会。
 *
 * 用途有两个：给没用过的人看会议助手怎么工作；改了提示词、工具或模型之后，
 * 在真实页面上走一遍全流程，看有没有出问题。
 *
 * 会议由主持人（王部长）主持，会议助手是他的副手。台词里安排了几种情况：
 * 主持人邀请播报议程、闲聊跑题（先提示主持人，主持人点采纳后才开口）、
 * 决议缺要素、定不下来的事项、记录推进议题（不口头宣布）、要求小结。
 * 整场不应该出现逐个点名。
 */

export interface DemoStep {
  id: string;
  /** 参会人姓名，对应 DEMO_VOICES */
  say: string;
  text: string;
  /** 这一步想看会议助手的什么反应，显示在演示面板上 */
  watch: string;
  /** reply：说完后等会议助手说完再继续；next：紧接着下一位发言 */
  then: "reply" | "next";
  /**
   * suggest：这段话是跑题，会议助手应当先在看板上提示主持人（不直接开口）；
   *   演示里由运行器扮演主持人点“采纳”，之后会议助手开口，发言人停下。
   * interrupt：直接提醒模式下，会议助手直接开口，发言人停下。
   */
  expect?: "suggest" | "interrupt";
  /** advance：这一步之后议程应当推进；没有推进就用 retry 再说一次 */
  until?: "advance";
  retry?: string;
}

export const DEMO_CONFIG: MeetingConfig = withCallNames({
  topic: "螺杆钻具交付专题会",
  meetingType: "专题会（演示）",
  chair: "生产制造部部长",
  chairName: "王建国",
  totalDurationMinutes: 6,
  style: "strict",
  escalationPath: "提请总经理签批并留档",
  requirePreRead: false,
  attendees: [
    { id: "demo-wang", name: "王部长", dept: "生产制造部", role: "部长", required: false },
    { id: "demo-li", name: "李部长", dept: "技术研发部", role: "部长", required: false },
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
    mode: "semi_auto",
    threshold: 0.85,
    cooldownSeconds: 45,
    consecutiveHits: 1,
  },
});

/** 每位参会人一种音色，听得出是不同的人 */
export const DEMO_VOICES: Record<string, string> = {
  王部长: "Charon",
  李部长: "Orus",
  赵部长: "Kore",
  陈部长: "Puck",
};

export const DEMO_STEPS: DemoStep[] = [
  {
    id: "invite",
    say: "王部长",
    text: "好，现在开会。请会议助手先播报一下今天的议程。",
    watch: "主持人邀请后才播报议程，说完把话交还，不宣布讨论开始",
    then: "reply",
  },
  {
    id: "problem",
    say: "王部长",
    text: "我先说一下情况。硫化罐只有一台，上个月定子硫化平均要排队三天，整条螺杆线都被它拖慢了，这是现在最大的瓶颈。",
    watch: "正常发言，会议助手应保持安静",
    then: "next",
  },
  {
    id: "cause",
    say: "李部长",
    text: "我们算过，把硫化模具从一模一件改成一模两件，单罐产能可以提高百分之八十，模具改造大概需要两周。",
    watch: "正常发言，会议助手应保持安静",
    then: "reply",
  },
  {
    id: "off_topic",
    say: "陈部长",
    text: "说到这个，下个月公司团建大家想去哪里啊？我觉得去海边不错，可以吃海鲜，上次那家餐厅的螃蟹特别好吃。对了，你们看昨天晚上的球赛了吗，最后那个进球太精彩了，我到现在还在回味。",
    watch: "闲聊跑题：看板先提示主持人，主持人采纳后会议助手才向他请示着提醒",
    expect: "suggest",
    then: "reply",
  },
  {
    id: "proposal",
    say: "赵部长",
    text: "回到硫化的问题。我建议就按李部长说的办，把模具改成一模两件，由技术研发部李部长负责。",
    watch: "方案只说了责任人，会议助手应向主持人确认时限、验证方式和关闭证据，不应自己编",
    then: "reply",
  },
  {
    id: "complete",
    say: "王部长",
    text: "完成时限定在十月二十日之前。验证方式是改造后连续一周单罐日产量达到十二件，关闭证据是生产制造部出具的周产量报表。",
    watch: "四要素齐全，会议助手记录决议并读回一遍，不点名",
    then: "reply",
  },
  {
    id: "close_1",
    say: "王部长",
    text: "第一个议题就这样定了，我们进入下一个议题。",
    watch: "会议助手只记录推进、看板同步，不口头宣布新议题",
    then: "reply",
    until: "advance",
    retry: "好，进入下一个议题。",
  },
  {
    id: "plan",
    say: "赵部长",
    text: "下个月有两个订单撞在一起，一个是新疆客户的二十套螺杆，一个是租赁池要补的十五套，产能只够先做一个。",
    watch: "正常发言，会议助手应保持安静",
    then: "next",
  },
  {
    id: "blocked",
    say: "陈部长",
    text: "新疆客户的到货期限，他们到现在还没有书面确认，所以先做哪一个今天定不下来。",
    watch: "正常发言，会议助手应保持安静",
    then: "next",
  },
  {
    id: "open_item",
    say: "李部长",
    text: "那这一条今天先不定，记为未决事项，由赵部长跟进，周五之前拿到客户的书面确认。",
    watch: "会议助手登记未决事项并说明上报路径",
    then: "reply",
  },
  {
    id: "wrap_up",
    say: "王部长",
    text: "今天的议题都谈完了，请会议助手做个小结。",
    watch: "会议助手汇报决议和未决事项的数量，请主持人确认，不宣布散会",
    then: "reply",
  },
];
