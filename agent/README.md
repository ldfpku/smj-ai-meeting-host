# Agent Deployment

This directory contains a LiveKit Agent that can be deployed to LiveKit Cloud using GitHub Actions CI/CD.

## Prerequisites

1. **LiveKit Cloud Account**: Sign up at [cloud.livekit.io](https://cloud.livekit.io)
2. **Google AI API Key**: Get from [Google AI Studio](https://aistudio.google.com/apikey)

## Local Development

### Setup

1. Install `uv` (if not already installed):
```bash
# macOS/Linux
curl -LsSf https://astral.sh/uv/install.sh | sh

# Or with Homebrew
brew install uv

# Windows
winget install --id=astral-sh.uv -e
```

2. Install the LiveKit CLI (`lk`). It runs the agent locally and hot-reloads it on file changes:
```bash
# macOS
brew install livekit-cli

# Linux
curl -sSL https://get.livekit.io/cli | bash

# Windows
winget install LiveKit.LiveKitCLI
```

3. Install dependencies (creates `.venv` from `uv.lock`):
```bash
uv sync
```

4. Create `.env.local` with your secrets, either here in `agent/` or at the repository root (the agent reads both, and the root file is shared with the web frontend):
```bash
LIVEKIT_URL=your_livekit_url
LIVEKIT_API_KEY=your_api_key
LIVEKIT_API_SECRET=your_api_secret
GEMINI_API_KEY=your_gemini_key
JEV_API_KEY=your_jev_key        # optional: off-topic detection
```
The agent uses its own `GEMINI_API_KEY`. A key typed into the web UI is only used when the agent has none.
To get these secrets, you can use the LiveKit CLI following the instructions below (steps 1-4).

5. Give `lk` access to the same LiveKit project, once:
```bash
lk cloud auth
```
`lk` takes the LiveKit credentials from its own project config or from the `LIVEKIT_URL`, `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` environment variables; it does **not** read `.env.local`. Exporting those three variables in your shell is the alternative to `lk cloud auth`.

### Run Locally

```bash
lk agent dev main.py
```

- The `main.py` argument is required: `lk` only auto-detects `agent.py` or `src/agent.py`.
- `lk` finds the interpreter in `.venv` by itself, so activating the virtualenv is optional.
- Files are watched and the agent restarts on change (`--no-reload` disables this).
- `python main.py dev` and `uv run main.py dev` still work but are deprecated since livekit-agents 1.8: they print a deprecation warning and no longer auto-reload.

In production the container runs the thin, non-deprecated CLI instead (see `Dockerfile`):
```bash
python -m livekit.agents start
```

If an agent is already deployed to the same LiveKit project, give the local one its own
name so that your sessions are not dispatched to the deployed agent. Set the same value
for the web server:
```bash
LIVEKIT_AGENT_NAME=smjar-dev
```

### Tests

```bash
uv run pytest
```

The tests cover the model capability table, the intervention gate, the off-topic
detector (with a stubbed judge), the handling of agenda titles and the prepared audio
clips. They need no network.

### Simulated meeting

```bash
uv run python sim/run.py
uv run python sim/run.py --model gemini-3.1-flash-live-preview
```

Runs a whole meeting of about three minutes against the running agent, unattended:
four people (one synthetic voice each) talk into the one microphone of the room, go off
topic once, agree on a decision, leave one matter open and ask for the summary. The
script only speaks; interrupting, recording, the roll call, moving on and closing are up
to the moderator. It ends with a list of checks and writes `report.md`, `minutes.md` and
`events.json` to `sim/runs/<time>/`.

It needs the agent (`lk agent dev main.py`, with `LIVEKIT_AGENT_NAME=smjar-dev`) and, for
the minutes, the web app on `http://localhost:3000`. The meeting is described in
`sim/scenario.json`. Every run uses the real services and costs what a three-minute
meeting costs.

## CI/CD Deployment to LiveKit Cloud

### First-Time Setup

1. **Install LiveKit CLI** (for initial setup):
```bash
curl -sSL https://get.livekit.io/cli | bash
```
For other platforms (macOS, Windows) - check [LiveKit CLI documentation](https://docs.livekit.io/home/cli/).

2. **Authenticate with LiveKit Cloud**:
```bash
lk cloud auth
```

3. **Get your agent ID and deploy to LiveKit Cloud:**
   - Create and deploy your agent for the first time: `lk agent create`
   - The agent ID will be written to the generated `livekit.toml` file. Make sure to keep this file in the `agent/` directory to enable cloud deployment in CI/CD pipeline.

4. **Get environment variables from LiveKit**:
   - Run `lk app env --write` to create `.env.local` with `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, and `LIVEKIT_URL`
   
   **Alternative:** Get credentials manually from the dashboard:
   - Log into [cloud.livekit.io](https://cloud.livekit.io/projects/p_/settings/project)
   - Go to Settings → API keys to create a new API key/secret pair
   - Copy your LiveKit URL from Settings → Project

5. **Set up GitHub Secrets and Environment Variables**:
   
   Go to your GitHub repository → Settings → Env → production
   
   **Add the following secrets:**

   - `LIVEKIT_URL`: Your full LiveKit Cloud URL (e.g., `wss://your-project.livekit.cloud`)
   - `LIVEKIT_API_KEY`: Your LiveKit API key from `.env.local` generated in step 4
   - `LIVEKIT_API_SECRET`: Your LiveKit API secret from `.env.local`
   - `GEMINI_API_KEY`: the Gemini key the deployed agent uses
   - `JEV_API_KEY`: the TypeSafe Jev key for the off-topic detection

   The workflow hands the last two to the agent as secrets. Without `GEMINI_API_KEY`
   the deployed agent cannot open a Live session: the key is no longer passed along
   by the browser.

6. **Run the workflow**:
   
   The workflow file is located at `.github/workflows/deploy-agent.yml`.
   It only runs when triggered manually in the GitHub Actions UI (`workflow_dispatch`).

### Monitoring

After deployment:

- View logs: `lk agent logs`
- Check status: `lk agent status`
- View in dashboard: [cloud.livekit.io/projects/p_/agents](https://cloud.livekit.io/projects/p_/agents)

## Project Structure

```
agent/
├── main.py              # Agent code; exposes the AgentServer `server` that lk runs
├── model_caps.py        # What each supported Live model accepts
├── intervention.py      # The gate that decides who may interrupt, and when
├── drift_detector.py    # Off-topic detection on the transcript (TypeSafe Jev)
├── fast_transcript.py   # Streaming transcript for the detection (hears mid-sentence)
├── spoken_clips.py      # Interruptions synthesised ahead of time
├── direct_voice.py      # Plays them on a track of their own, at once
├── sim/                 # Simulated meeting (uv run python sim/run.py)
├── tests/               # Unit tests (uv run pytest)
├── pyproject.toml       # Python project & dependencies (uv)
├── .python-version      # Python version specification
├── Dockerfile          # Docker build configuration
├── .dockerignore       # Files to exclude from Docker build
├── .env.local          # Local secrets (not in git)
├── livekit.toml        # Agent deployment config (keep local copy, gitignored)
└── README.md           # This file
```

## Resources

- [LiveKit Agents Documentation](https://docs.livekit.io/agents/)
- [LiveKit Cloud Deployment Guide](https://docs.livekit.io/agents/ops/deployment/)
- [LiveKit CLI Reference](https://docs.livekit.io/agents/ops/deployment/cli/)

