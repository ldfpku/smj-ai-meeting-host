# SMJAR · AI 会议主持人

SMJ 公司内部的实时语音会议主持系统：加载公司标准会议模板，严格控时、跑题即刻打断、
按名单点名征询、催办带齐四要素的决议，并一键导出可回执确认的会议纪要。

技术上是一套 LiveKit Agents + Google Gemini Live API 的实时语音应用，
派生自 livekit-examples/gemini-playground（Apache 2.0，见 LICENSE）。

## Repository Structure

### /agent

This directory contains the agent implementation in build on the LiveKit [Python Agents framework](https://github.com/livekit/agents).

### /web

This directory houses the web frontend, built with Next.js.

## Prerequisites

- Python 3.9 or higher
- pip (Python package installer)
- LiveKit Cloud or self-hosted LiveKit server

## Getting Started

### Env Setup

1. Copy the sample environment file: `cp .env.sample .env.local`
2. Open `.env.local` in a text editor and enter your LiveKit credentials

### Agent Setup

1. Navigate to the `/agent` directory
2. Create a virtual environment: `uv venv`
3. Activate the virtual environment:
   - On macOS and Linux: `source .venv/bin/activate`
   - On Windows: `.venv\Scripts\activate`
4. Install dependencies: `uv pip install -e .` or `uv pip install -r requirements.txt`
5. Run the agent in development mode: `python main.py dev`

### Web Frontend Setup

1. Navigate to the `/web` directory
2. Install dependencies: `pnpm install`
3. Run the development server: `pnpm dev`
4. Open [http://localhost:3000](http://localhost:3000) in your browser

## SMJ 会议主持人

本仓库在上游 playground 之上构建了 **SMJ 公司 AI 会议主持人**：加载公司真实的会议模板，
严格控时、跑题即刻打断、按名单点名征询、催办四要素决议，并一键导出正式会议纪要。

### 它解决的问题

`smj-manage` 语料中**没有会议制度文件，也没有会议纪要模板**，「议程」「待办」「议定」在全库
出现 0 次。同时 DISC 测评报告 §5.3 已为这支「I 均值 6.1、9/18 人 I≤5」的管理团队写好三条
议事规则，却缺少执行工具：**书面前置 / 点名发言（沉默不等于同意）/ 会后书面回执确认**。
本功能就是这三条规则的执行器。

### 会议模板

`web/src/data/meeting-templates.ts` 内置 7 个模板，固定议题**逐字取自业务流程手册**，
每个模板在界面上都标注出处以便追溯：

| 模板 | 出处 |
|---|---|
| 月度产销租协同会 | 业务流程手册 P-01 |
| 月度经营分析会 | 业务流程手册 F-01 |
| 螺杆产业化专项组周例会 | 技术研发部职能 v2（BICO 一期转化排期） |
| MRB 不合格品评审 | 业务流程手册 Q-02 |
| 技术评审组 | 业务流程手册总览 + 阶段门五种结论 |
| 失效分析与质量归零（8D） | 业务流程手册 Q-03 |
| 基地每周安全会议 | 业务流程手册 Q-04 |

### 主持人工具（`agent/main.py`）

| 工具 | 作用 |
|---|---|
| `warn_topic_drift` | 跑题黄牌 + 提示音，并指示模型立刻开麦打断 |
| `request_speaker` | 点名征询某位参会人，看板高亮——沉默不等于同意 |
| `record_decision` | 记录决议，强制四要素：责任人 / 完成时限 / 验证方式 / 关闭证据 |
| `record_open_item` | 登记未决事项并写明升级路径（默认总经理签批） |
| `advance_agenda` | 推进议程；带**议而不决闸门**：本议题无决议也无未决事项时拒绝推进 |
| `get_meeting_timer` | 返回用时，并附带「谁还没表态」「哪条决议要素不全」 |

### 领域接地数据（需人工同步）

以下三个模块是从**另外两个仓库**摘录后签入本仓库的，运行时不读取那些路径
（agent 会部署到 LiveKit Cloud，读不到本地盘）。**源语料更新时需人工复核这几个文件**，
每个文件头部都标注了来源路径与摘录日期：

| 文件 | 来源 |
|---|---|
| `web/src/data/smj-org.ts` | `smj-manage`：8 个部门、51 个岗位、35 条业务流程（M-01…H-06） |
| `web/src/data/smj-glossary.ts` | `smj-tec-docs/knowledge/90-元/术语表.md`（中英术语唯一权威来源）+ 受控文档编号 |
| `web/src/data/meeting-templates.ts` | `smj-manage/202608/业务流程/`（各模板固定议题） |

### 隐私边界

接地数据**只取部门名与岗位名**，用于把决议归口到正确部门。
DISC 性格测评结论、绩效评价与人员姓名**不写入任何提示词或配置**；
参会人名单由会议组织者自行填写，「必须发言」也由组织者勾选，而非由测评分数推导。

## Deployment

The agent can be deployed in a variety of ways: [Deployment & Scaling Guide](https://docs.livekit.io/agents/deployment/)

The web frontend can be deployed using your preferred Next.js hosting solution, such as [Vercel](https://vercel.com/).

## Troubleshooting

Ensure the following:

- Both web and agent are running
- Environment variables are set up correctly
- Correct versions of Python and pnpm are installed

## Additional Resources

For more information or support, please refer to [LiveKit docs](https://docs.livekit.io/).

## License

Apache 2.0
