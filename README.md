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

- Python 3.12 or higher
- [uv](https://docs.astral.sh/uv/) (Python package manager)
- [LiveKit CLI](https://docs.livekit.io/home/cli/) (`lk`), which runs the agent locally with hot reload
- LiveKit Cloud or self-hosted LiveKit server

## Getting Started

### Env Setup

1. Copy the sample environment file: `cp .env.example .env.local`
2. Open `.env.local` in a text editor and enter your LiveKit credentials, `GEMINI_API_KEY`
   and `JEV_API_KEY` (off-topic detection; optional, see below)

Both keys stay on the server side: the agent reads them from its own environment and
the web server uses `GEMINI_API_KEY` for the voice preview and the AI minutes. Neither
is sent to the browser.

If an agent is already deployed to the same LiveKit project, set `LIVEKIT_AGENT_NAME`
(for example `smjar-dev`) for both the agent and the web server while developing.
Otherwise your local sessions may be dispatched to the deployed agent.

### Agent Setup

1. Navigate to the `/agent` directory
2. Install dependencies (creates `.venv` from `uv.lock`): `uv sync`
3. Let the LiveKit CLI use your project credentials, once: `lk cloud auth`
   (pick the same project as in `.env.local`). `lk` does not read `.env.local`;
   alternatively export `LIVEKIT_URL`, `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` in your shell.
4. Run the agent in development mode with hot reload: `lk agent dev main.py`

`lk` finds the interpreter in `.venv` by itself, so activating the virtualenv is optional.
`python main.py dev` is deprecated since livekit-agents 1.8 and no longer auto-reloads;
see [agent/README.md](agent/README.md) for details and the production command.

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
| `warn_topic_drift` | 模型发现跑题时先申请介入；是否允许开口由介入闸门决定（冷却期、半自动模式下会被要求保持静默） |
| `request_speaker` | 点名征询某位参会人，看板高亮——沉默不等于同意 |
| `record_decision` | 记录决议，强制四要素：责任人 / 完成时限 / 验证方式 / 关闭证据 |
| `record_open_item` | 登记未决事项并写明升级路径（默认总经理签批） |
| `advance_agenda` | 推进议程；带**议而不决闸门**：本议题无决议也无未决事项时拒绝推进 |
| `get_meeting_timer` | 返回用时，并附带「谁还没表态」「哪条决议要素不全」 |

### 模型

| 用途 | 模型 | 位置 |
|---|---|---|
| 实时主持（听、说、调用工具） | `gemini-3.8-live`（默认），备选 `gemini-3.8-live-extended-thinking`、`gemini-3.1-flash-live-preview` | `agent/model_caps.py`、`web/src/data/models.ts` |
| 跑题判断（输出偏题概率） | TypeSafe Jev（`jev-latest`） | `agent/drift_detector.py` |
| 会议纪要整理 | `gemini-3.8-flash` | `web/src/app/api/minutes/route.ts` |
| 音色试听 | `gemini-3.8-flash-tts` | `web/src/app/api/voice-preview/route.ts` |

各模型的选型依据、实测数据，以及可本地部署的开源模型调研，见
[docs/model-strategy.md](docs/model-strategy.md)。产品需求与当前实现状态的对照见
[docs/PRD.md](docs/PRD.md)。

### 跑题检测与介入

- **Jev 主导，Live 模型兜底**：agent 把最近几秒的转写交给 Jev 判断，偏题概率达到阈值
  即介入；Live 模型自己发现跑题时也会申请介入。两者共用一个闸门（`agent/intervention.py`），
  同一段跑题不会被打断两次。
- **自动 / 半自动**：自动模式下 AI 主持人直接开口打断；半自动模式下只在看板上提示，
  由人点击「打断并引导」后才开口。会前在会议配置里设定，会中可在看板上随时切换。
- **撤销打断**：判断错了可以一键撤销——主持人立即停止发言，该次记为误判，
  并在两倍冷却时间内不再自动打断。
- **打断用语**：固定为两句短话（约 7 秒），只用日常用词，开头随主持风格变化，
  例如「各位，先停一下。这个话题我们会后再聊，现在先回到「议题名」。」
  文字在 `agent/intervention.py` 的 `spoken_interruption` 里，改这一处即可。
- **边说边听**：跑题判断用的是一路单独的流式识别（`gemini-3.5-transcribe-live`），
  发言人还在说话时就能判断，不必等他停顿。看板上的转写和纪要仍用 Live 模型的转写。
- **说话途中打断**：每个议题的打断语音在议题开始时预先合成好，判定跑题后由 agent
  走单独的音轨直接播放，不经过 Live 模型（Live 模型只在会场停顿时才开口）。
  预制语音还没准备好时，退回到让 Live 模型来说。
- **议题已有结论、大家谈到了别的议题**：不当作跑题打断，而是提示主持人点名或推进议程。
- **没有配置 `JEV_API_KEY` 时**：只剩 Live 模型自行判断，看板上不显示偏题概率。

### 会议记录与纪要

- 转写、决议、未决事项和介入记录保存在**浏览器本机**（IndexedDB），刷新页面后仍可查看
  上一场会议并生成纪要。数据不会上传；换一台电脑或换一个浏览器就看不到。
- 纪要整理默认走公司的 AI 网关（`AI_WORKER_URL` / `AI_WORKER_KEY`，OpenAI 格式，
  模型 `glm-5.3-flash`），约需 20 – 50 秒。网关失败时改用 Gemini，界面上会提示。
  设置 `MINUTES_PROVIDER=worker` 可以禁止改用 Gemini。
- 「AI 纪要」由记录人手动触发：AI 根据转写整理讨论要点、待确认事项和时间线，
  生成可编辑的草稿，校对后再复制或导出。决议与未决事项始终以会上登记的记录为准。
- 转写**不区分具体发言人**（当前语音模型不支持说话人分离），所有参会人的发言都记为「会场」。

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

The deployed agent needs `GEMINI_API_KEY` and `JEV_API_KEY` in its environment. The
GitHub workflow passes them on from the secrets of the `production` environment; see
[agent/README.md](agent/README.md).

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
