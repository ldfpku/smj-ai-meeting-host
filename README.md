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

### 从文档导入会议配置

会议配置弹窗顶部的「从文档导入」可以把会议通知、议程这类文档转换成标准配置：
选择 md、docx、txt 文件，或直接粘贴文字，十几秒后会议名称、主持岗位、参会人和议题
就填进表单。结果只填进表单，核对后点「确认并保存」才生效。

- 文件在浏览器里读取（docx 的表格、标题和列表会保留），只把文字发给公司的 AI 网关
  （`AI_WORKER_URL` / `AI_WORKER_KEY`）。这个功能不使用其他厂商的模型。
- 模型默认 `glm-5.3-flash`，失败时改用 `deepseek-v4-flash-0731`；
  `AI_WORKER_IMPORT_MODEL` 可以换成网关上的其他模型。2026-09-28 的比较结果写在
  `web/src/app/api/meeting-import/route.ts` 开头。
- 模型只负责读文档。部门、岗位、流程编号由 `web/src/lib/meeting-import.ts` 对照公司清单
  校验：「生产部」「质量部部长」这样的简称会换成清单里的名称；清单里没有的照文档原样填写，
  并在界面上提示。
- 文档没写的内容不会补写：没写目标的议题目标留空并提示；没写用时的议题按文档的总时长
  平均分配，连总时长也没写就先按 10 分钟填写，两种情况都会提示。
- 不支持旧版 `.doc`（请另存为 docx）和扫描件、图片里的文字。文档最多读前 6 万字。

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

### 发言与表态

- **每项议题开始时指定谁先讲**：议程里可以给每项议题填「汇报人」，主持人在开场和
  推进议题时会请他先介绍情况；没填时请"负责这项工作的同事"。
- **点名有两种**：请某人先发言（`request_speaker` 的 `purpose` 为 `report`），
  和征询对结论的表态（`stance`）。议题还没有人发言时不能征询表态。
- **决议只记会上说过的内容**：方案缺要素时主持人追问，不自行补全。

### 主持人的声音

主持人说的话有三个来源：

| 内容 | 由谁念 | 原因 |
|---|---|---|
| 跑题打断 | 预先合成的语音，单独一条音轨，立即播出 | 实时模型只在会场停顿时才开口 |
| 未决事项的宣布、会议总结 | 预先合成的语音，排在主持人的发言队列里 | 实时模型念固定的句子时会走样：实测把「总经理」念成了「总理」 |
| 开场、点名、追问、推进议题 | 实时模型（Gemini Live） | |

- 会议总结的句子由代码按看板上的记录组织（`spoken_summary`），条数不会数错。
- 实时模型决定不说话时，偶尔仍会生成一小段声音，文字是一段占位注释。
  `agent/speech_gate.py` 把这样的输出连同声音一起丢掉。
- 模拟会议（`agent/sim/run.py`）会把主持人的声音录下来再转写，
  与文字对照，用来发现念错的词。

### 会议怎样结束（费用）

会议开着就在花钱：只要页面连着，会场的声音就持续送给 Gemini Live 和流式转写，
LiveKit 按连接时长计费，有没有人说话都一样。会议因此有四种结束方式，
任何一种都会关闭房间、停止所有模型调用：

| 方式 | 说明 |
|---|---|
| 点「结束会议」 | 看板右上角，要点两次确认 |
| 离开页面 | 关闭或刷新页面、点「断开」后，agent 等 20 秒确认人没有回来，然后结束 |
| 长时间无人发言 | 10 分钟没有人说话时主持人口头提醒、看板出现倒计时，再过 1 分钟结束。有人说话或点「继续开会」即取消 |
| 达到时长上限 | 上限是计划时长的两倍，且至少比计划多 30 分钟，最多 240 分钟。到点前 5 分钟提醒，点「延长 30 分钟」可以延长 |

时限可在 agent 的环境变量里调整：`MEETING_IDLE_MINUTES`（默认 10）、
`MEETING_MAX_MINUTES`（默认 240）。规则在 `agent/meeting_limits.py`。

结束之后，转写、决议和未决事项仍留在页面上和本机，可以照常生成纪要。

### 演示会议

连接按钮旁边的「演示会议」会自动开一场约 4 分钟的会：四位参会人由四种音色的合成语音
扮演，代替麦克风发进房间；主持人、跑题检测、看板、转写都是真实运行的。
会议里安排了闲聊跑题、只说了责任人的方案、定不下来的事项、要求推进和要求总结，
结束后面板上列出各项检查的结果。

- 用来给没用过的人看效果，也用来在改了提示词、工具或模型之后走一遍全流程。
- 台词在 `web/src/data/demo-meeting.ts`，流程和检查在 `web/src/lib/demo/runner.ts`。
- 每次演示都使用真实的服务：一场 4 分钟的会议，外加合成约 20 句台词。
- 演示期间不采集真实麦克风。

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

域名 `smjtools.com` 已由原 DF 账号转到 ZY 账号。网页 Worker、域名绑定和 Cloudflare Access
现在都在 ZY（`wrangler.jsonc` 里的 `account_id` 锁定账号）；DF 里留着的同名旧 Worker 不再使用，
也不要再往 DF 发布。LiveKit agent 与 Gemini 不受域名转移影响。

线上地址：<https://meeting.smjtools.com>

| 部分 | 运行在 | 怎么发布 |
|---|---|---|
| 网页 | Cloudflare Workers（ZY 账号，Worker 名 `smj-meeting`） | 在 `web/` 下构建后 `bash scripts/cf-deploy.sh` |
| agent | LiveKit Cloud | GitHub Actions 里手动运行 `Deploy Agent to LiveKit Cloud` |

### 谁能登录

域名前面是 Cloudflare Access（Zero Trust）。打开页面先要输入邮箱，收到验证码后才能进入；
不在名单里的邮箱收不到验证码。页面、接口、静态文件都在保护范围内。

名单在 ZY 账号的 Cloudflare 控制台：Zero Trust → Access → Policies → `smj-meeting-users`。
增减人员只改这一处，不需要重新发布。名单是会议应用自己的，不随公司其他应用的名单自动变化。

Worker 只绑定了这一个域名，没有开放 `workers.dev` 和预览地址，否则会绕过登录。

### 发布网页

```bash
cd web
pnpm cf:build                 # Linux、macOS、WSL
bash scripts/cf-deploy.sh
```

在 Windows 上 OpenNext 构建出的包运行时会出错，改用容器构建（需要 Docker）：

```bash
cd web
bash scripts/cf-build-in-docker.sh
bash scripts/cf-deploy.sh
```

不要直接用 `pnpm exec wrangler deploy`：本机日常的 `wrangler login` 可能是别的账号（DF）。
`cf-deploy.sh` 把 ZY 的登录放在单独的目录（默认 `~/.cloudflared-zy/wrangler-home`，
可用 `WRANGLER_PROFILE_DIR` 改），首次运行会打开浏览器，选 ZY 账号并允许；
账号不是 `wrangler.jsonc` 里锁定的那个时会拒绝发布。

密钥存在 Worker 的 secret 里，只在首次发布或更换时设置：
`LIVEKIT_URL`、`LIVEKIT_API_KEY`、`LIVEKIT_API_SECRET`、`GEMINI_API_KEY`、
`AI_WORKER_URL`、`AI_WORKER_KEY`。可以逐个用 `bash scripts/cf-deploy.sh secret put <名称>`，
或在仓库根运行 `bash web/scripts/cf-set-secrets.sh`，把 `.env.local` 里的这六项一次写入（不打印值）。
不要设置 `LIVEKIT_AGENT_NAME`：线上要连的是默认名称的 agent。

Worker 指定在美国西部运行（`wrangler.jsonc` 的 `placement`）。Gemini 会拒绝来自部分地区
（包括香港）的请求，不指定的话 Worker 会在离访问者最近的节点运行。

### 发布 agent

**先发布 agent，再发布网页。** 网页的新功能往往依赖 agent 的新接口；
顺序反了的话，线上正在开的会可能因为 agent 不认识新请求而出错。

也可以不经过 GitHub，直接从本地目录发布（在 `agent/` 下，需要 `livekit.toml`）：
`lk agent deploy`。

The deployed agent needs `GEMINI_API_KEY` and `JEV_API_KEY` in its environment. The
GitHub workflow passes them on from the secrets of the `production` environment; see
[agent/README.md](agent/README.md). 该环境里还需要 `LIVEKIT_URL`、`LIVEKIT_API_KEY`、
`LIVEKIT_API_SECRET`。

## Troubleshooting

Ensure the following:

- Both web and agent are running
- Environment variables are set up correctly
- Correct versions of Python and pnpm are installed

## Additional Resources

For more information or support, please refer to [LiveKit docs](https://docs.livekit.io/).

## License

Apache 2.0
