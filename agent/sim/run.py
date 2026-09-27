"""Simulated meeting: runs the moderator through a whole meeting, unattended.

Several people (one synthetic voice each) talk into the one microphone of a
meeting room, the way the product is used. The script only speaks; everything
the moderator does (interrupting, recording decisions, roll call, moving on,
closing) has to happen on its own. Afterwards the minutes are generated and a
report lists what went wrong.

    cd agent
    uv run python sim/run.py                       # default scenario, gemini-3.8-live
    uv run python sim/run.py --model gemini-3.1-flash-live-preview

Needs a running agent (launch config `agent-local`) and, for the minutes, the
web app on http://localhost:3000. Clips are synthesised once and cached.
"""

from __future__ import annotations

import argparse
import array
import asyncio
import base64
import hashlib
import json
import math
import os
import re
import subprocess
import sys
import time
import uuid
import wave
from io import BytesIO
from pathlib import Path

import httpx
from dotenv import load_dotenv
from livekit import api, rtc

HERE = Path(__file__).parent
ROOT = HERE.parents[1]
CACHE = HERE / ".cache"
RUNS = HERE / "runs"

load_dotenv(ROOT / ".env.local")

SAMPLE_RATE = 24000
FRAME_SAMPLES = SAMPLE_RATE * 20 // 1000
TTS_MODEL = os.environ.get("GEMINI_TTS_MODEL", "").strip() or "gemini-3.8-flash-tts"
TTS_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions"

T0 = time.time()
events: list[dict] = []


def now() -> float:
    return round(time.time() - T0, 2)


def log(kind: str, **fields) -> dict:
    entry = {"t": now(), "kind": kind, **fields}
    events.append(entry)
    shown = " ".join(f"{k}={v}" for k, v in fields.items())
    print(f"[{entry['t']:7.2f}] {kind:20s} {shown}"[:240], flush=True)
    return entry


# ---- preparation -------------------------------------------------------------


def synthesize(voice: str, text: str) -> bytes:
    """One spoken line as 24 kHz mono PCM, cached by voice and text."""
    key = hashlib.sha1(f"{TTS_MODEL}|{voice}|{text}".encode("utf-8")).hexdigest()[:12]
    file = CACHE / "clips" / f"{voice}-{key}.wav"
    if not file.exists():
        response = httpx.post(
            TTS_ENDPOINT,
            headers={"x-goog-api-key": os.environ["GEMINI_API_KEY"]},
            json={
                "model": TTS_MODEL,
                "input": text,
                "response_format": {"type": "audio"},
                "generation_config": {"speech_config": [{"voice": voice}]},
            },
            timeout=120,
        )
        response.raise_for_status()
        data = None
        for step in response.json().get("steps", []):
            for part in step.get("content") or []:
                if part.get("type") == "audio" and part.get("data"):
                    data = base64.b64decode(part["data"])
        if not data or data[:4] != b"RIFF":
            raise RuntimeError(f"no WAV audio returned for a line of {voice}")
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_bytes(data)

    with wave.open(BytesIO(file.read_bytes()), "rb") as w:
        if w.getframerate() != SAMPLE_RATE or w.getnchannels() != 1:
            raise RuntimeError(f"unexpected clip format: {w.getframerate()} Hz")
        return w.readframes(w.getnframes())


def compile_web_data() -> Path:
    """The moderator prompt and the minutes template live in the web app
    (TypeScript). They are compiled once so the simulation uses the real ones."""
    out = CACHE / "js"
    sources = [ROOT / "web/src/data" / n for n in ("meeting.ts", "meeting-minutes.ts")]
    newest = max(p.stat().st_mtime for p in (ROOT / "web/src/data").glob("*.ts"))
    built = out / "meeting-minutes.js"
    if not built.exists() or built.stat().st_mtime < newest:
        out.mkdir(parents=True, exist_ok=True)
        files = " ".join(f'"{p}"' for p in sources)
        subprocess.run(
            f'pnpm exec tsc {files} --outDir "{out}" --module commonjs '
            "--target es2020 --skipLibCheck",
            cwd=ROOT / "web",
            shell=True,
            capture_output=True,
        )
        if not built.exists():
            raise RuntimeError("could not compile web/src/data (is `pnpm install` done?)")
    return out


def run_node(script: str, payload: dict) -> str:
    js = compile_web_data()
    payload_file = CACHE / "payload.json"
    payload_file.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    result = subprocess.run(
        ["node", "-e", script, str(js), str(payload_file)],
        capture_output=True,
        encoding="utf-8",
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr[-800:])
    return result.stdout


def build_instructions(config: dict) -> str:
    return run_node(
        "const [dir, file] = process.argv.slice(1);"
        "const m = require(dir + '/meeting.js');"
        "const c = JSON.parse(require('fs').readFileSync(file, 'utf8'));"
        "process.stdout.write(m.generateMeetingInstructions(c));",
        config,
    )


def build_minutes(payload: dict) -> str:
    return run_node(
        "const [dir, file] = process.argv.slice(1);"
        "const m = require(dir + '/meeting-minutes.js');"
        "const p = JSON.parse(require('fs').readFileSync(file, 'utf8'));"
        "p.now = new Date(p.now);"
        "process.stdout.write(m.generateMinutesMarkdown(p));",
        payload,
    )


# ---- the room ----------------------------------------------------------------


class Mic:
    """The room microphone: always on, silent unless somebody speaks."""

    def __init__(self):
        self.source = rtc.AudioSource(SAMPLE_RATE, 1)
        self.pending = bytearray()
        self.idle = asyncio.Event()
        self.idle.set()
        self.spoken_seconds = 0.0

    async def pump(self):
        silence = bytes(FRAME_SAMPLES * 2)
        size = FRAME_SAMPLES * 2
        while True:
            if len(self.pending) >= size:
                chunk = bytes(self.pending[:size])
                del self.pending[:size]
                self.spoken_seconds += 0.02
            else:
                self.pending.clear()
                self.idle.set()
                chunk = silence
            await self.source.capture_frame(
                rtc.AudioFrame(chunk, SAMPLE_RATE, 1, FRAME_SAMPLES)
            )

    def start(self, pcm: bytes):
        self.idle.clear()
        self.pending.extend(pcm)

    def stop(self):
        self.pending.clear()


class Ear:
    """Listens to the moderator's audio track."""

    def __init__(self):
        self.speaking = False
        self.last_loud = 0.0
        self.started_at = 0.0
        self.segments: list[tuple[float, float]] = []

    async def listen(self, track: rtc.Track):
        async for ev in rtc.AudioStream(track):
            samples = array.array("h", bytes(ev.frame.data))
            if not samples:
                continue
            rms = math.sqrt(sum(s * s for s in samples) / len(samples))
            t = time.time()
            if rms > 300:
                self.last_loud = t
                if not self.speaking:
                    self.speaking = True
                    self.started_at = t
                    log("moderator_audio_start")
            elif self.speaking and t - self.last_loud > 0.7:
                self.speaking = False
                seconds = round(self.last_loud - self.started_at, 1)
                self.segments.append((self.started_at - T0, seconds))
                log("moderator_audio_end", seconds=seconds)


class Meeting:
    def __init__(self, scenario: dict, model: str, agent_name: str):
        self.scenario = scenario
        self.config = scenario["config"]
        self.model = model
        self.agent_name = agent_name
        self.room = rtc.Room()
        self.mic = Mic()
        self.ear = Ear()
        self.agent_state = ""
        self.agent_identity = ""
        self.transcript: dict[str, dict] = {}
        self.decisions: dict[str, dict] = {}
        self.open_items: list[dict] = []
        self.agenda_index = 0
        self.tasks: list[asyncio.Task] = []
        self.steps: list[dict] = []
        self.answered = 0

    # -- connection

    async def connect(self, instructions: str):
        room_name = f"sim-{uuid.uuid4().hex[:8]}"
        # the same metadata the web app puts into the token
        metadata = {
            "instructions": instructions,
            "model": self.model,
            "modalities": "audio_only",
            "voice": "Aoede",
            "temperature": 0.8,
            "max_output_tokens": None,
            "meeting_config": self.config,
        }
        token = (
            api.AccessToken(os.environ["LIVEKIT_API_KEY"], os.environ["LIVEKIT_API_SECRET"])
            .with_identity("human")
            .with_metadata(json.dumps(metadata, ensure_ascii=False))
            .with_grants(
                api.VideoGrants(
                    room=room_name,
                    room_join=True,
                    can_publish=True,
                    can_publish_data=True,
                    can_subscribe=True,
                )
            )
            .with_room_config(
                api.RoomConfiguration(
                    name=room_name,
                    agents=[api.RoomAgentDispatch(agent_name=self.agent_name)],
                )
            )
            .to_jwt()
        )

        room = self.room

        @room.on("participant_connected")
        def _joined(p: rtc.RemoteParticipant):
            self.agent_identity = p.identity
            log("moderator_joined", identity=p.identity)

        @room.on("participant_disconnected")
        def _left(p: rtc.RemoteParticipant):
            log("moderator_left", identity=p.identity)

        @room.on("track_subscribed")
        def _track(track, publication, participant):
            if track.kind == rtc.TrackKind.KIND_AUDIO:
                self.tasks.append(asyncio.create_task(self.ear.listen(track)))

        @room.on("participant_attributes_changed")
        def _attributes(changed, participant):
            if "lk.agent.state" in changed:
                self.agent_state = changed["lk.agent.state"]
                log("moderator_state", state=self.agent_state)

        @room.on("data_received")
        def _data(packet: rtc.DataPacket):
            if packet.topic == "meeting_update":
                self.on_update(json.loads(packet.data.decode("utf-8")))

        def _transcription(reader, identity):
            async def read():
                text = await reader.read_all()
                attrs = reader.info.attributes or {}
                segment = attrs.get("lk.segment_id") or reader.info.stream_id
                final = attrs.get("lk.transcription_final") == "true"
                role = "room" if identity == "human" else "moderator"
                known = self.transcript.get(segment)
                self.transcript[segment] = {
                    "role": role,
                    "text": text.strip(),
                    "final": final,
                    "at": known["at"] if known else int(time.time() * 1000),
                    "t": known["t"] if known else now(),
                }
                if final and text.strip():
                    log("transcript", role=role, text=text.strip())

            self.tasks.append(asyncio.create_task(read()))

        room.register_text_stream_handler("lk.transcription", _transcription)

        await room.connect(os.environ["LIVEKIT_URL"], token)
        log("connected", room=room_name, model=self.model, agent=self.agent_name)

        track = rtc.LocalAudioTrack.create_audio_track("mic", self.mic.source)
        await room.local_participant.publish_track(
            track, rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE)
        )
        self.tasks.append(asyncio.create_task(self.mic.pump()))

        for p in room.remote_participants.values():
            self.agent_identity = p.identity
        for _ in range(300):
            if self.agent_identity:
                return
            await asyncio.sleep(0.1)
        raise RuntimeError(
            f"no agent named '{self.agent_name}' joined: is the agent running?"
        )

    def on_update(self, data: dict):
        kind = data.pop("type", "?")
        if kind == "state_sync":
            state = data.get("state", {})
            if "decisions" in state:
                log("update:state_sync", keys=sorted(state))
            return
        if kind == "drift_score":
            log(
                "drift_score",
                p=round(data["confidence"], 2),
                reason=data.get("reasonCode"),
                jevMs=data.get("jevMs"),
            )
            return
        if kind == "new_decision":
            decision = data["decision"]
            log("update:new_decision", known=decision["id"] in self.decisions, **decision)
            self.decisions[decision["id"]] = decision
            return
        if kind == "new_open_item":
            item = data["openItem"]
            known = [o for o in self.open_items if o["id"] == item["id"]]
            self.open_items = [o for o in self.open_items if o["id"] != item["id"]] + [item]
            log("update:new_open_item", known=bool(known), **item)
            return
        if kind == "advance_agenda":
            self.agenda_index = data.get("currentAgendaIndex", self.agenda_index)
        log(f"update:{kind}", **data)

    # -- speaking and waiting

    def moderator_busy(self, settle: float) -> bool:
        return (
            self.ear.speaking
            or time.time() - self.ear.last_loud < settle
            or self.agent_state in ("thinking", "speaking")
        )

    async def wait_reply(self, min_wait: float = 4.0, max_wait: float = 45.0):
        """Give the moderator the floor until it has nothing more to say."""
        started = time.time()
        while time.time() - started < max_wait:
            await asyncio.sleep(0.1)
            if time.time() - started >= min_wait and not self.moderator_busy(2.0):
                return
        log("wait_reply_timeout", state=self.agent_state)

    async def say(self, speaker: str, text: str, step_id: str, yields: bool = False):
        pcm = await asyncio.to_thread(
            synthesize, self.scenario["voices"][speaker], text
        )
        seconds = round(len(pcm) / 2 / SAMPLE_RATE, 1)
        log("speech_start", step=step_id, speaker=speaker, seconds=seconds, text=text)
        self.mic.start(pcm)
        interrupted_at = None
        while not self.mic.idle.is_set():
            await asyncio.sleep(0.05)
            # somebody who is interrupted by the moderator stops talking
            if yields and self.ear.speaking and time.time() - self.ear.started_at > 1.0:
                interrupted_at = now()
                self.mic.stop()
                log("speech_yielded", step=step_id, speaker=speaker)
                break
        await self.mic.idle.wait()
        log("speech_end", step=step_id, speaker=speaker)
        return interrupted_at

    def moderator_text_since(self, t: float) -> str:
        return " ".join(
            s["text"]
            for s in sorted(self.transcript.values(), key=lambda s: s["t"])
            if s["role"] == "moderator" and s["t"] >= t
        )

    async def answer_roll_calls(self):
        """Whoever the moderator called on answers, like people in a room do."""
        for _ in range(4):
            calls = [e for e in events if e["kind"] == "update:roll_call"]
            waiting = calls[self.answered :]
            if not waiting:
                return
            self.answered = len(calls)
            # the board lights up before the moderator has asked the question
            await self.wait_reply(min_wait=2.0)
            agenda = self.config["agendas"][self.agenda_index]["id"]
            for call in waiting:
                name = call.get("attendeeName", "")
                if name not in self.scenario["voices"]:
                    continue
                answers = self.scenario["answers"]
                text = answers.get(agenda, {}).get(name) or answers["default"]
                await self.say(name, text, f"answer:{agenda}")
                await asyncio.sleep(0.6)
            await self.wait_reply()

    async def floor_to_moderator(self):
        await self.wait_reply()
        await self.answer_roll_calls()

    async def run(self):
        # the opening announcement
        for _ in range(250):
            if self.ear.speaking:
                break
            await asyncio.sleep(0.1)
        await self.wait_reply(min_wait=2.0, max_wait=60)
        log("opening_done")

        for step in self.scenario["steps"]:
            record = {"id": step["id"], "start": now(), "expect": step.get("expect")}
            self.steps.append(record)
            agenda_before = self.agenda_index
            if step.get("until") == "advance" and agenda_before > 0:
                # the moderator moved on by itself: nobody needs to ask
                record["skipped"] = True
                record["end"] = now()
                log("step_skipped", step=step["id"])
                continue
            record["yielded_at"] = await self.say(
                step["say"],
                step["text"],
                step["id"],
                yields=step.get("expect") == "interrupt",
            )
            record["speech_end"] = now()
            if step.get("then") == "reply":
                await self.floor_to_moderator()
            else:
                await asyncio.sleep(0.8)
            if step.get("until") == "advance" and self.agenda_index == agenda_before:
                # nothing happened: a person would ask once more
                record["retried"] = True
                await self.say(step["say"], step["retry"], step["id"] + ":retry")
                await self.floor_to_moderator()
            record["end"] = now()

        await asyncio.sleep(3)
        await self.room.disconnect()
        for task in self.tasks:
            task.cancel()


# ---- after the meeting ---------------------------------------------------------


def fetch_minutes(web: str, meeting: Meeting, started_at_ms: int) -> dict:
    lines = [
        {"role": s["role"], "text": s["text"], "at": s["at"]}
        for s in sorted(meeting.transcript.values(), key=lambda s: s["at"])
        if s["text"]
    ]
    try:
        response = httpx.post(
            f"{web}/api/minutes",
            json={
                "config": meeting.config,
                "decisions": list(meeting.decisions.values()),
                "openItems": meeting.open_items,
                "transcript": lines,
                "startedAt": started_at_ms,
            },
            timeout=180,
            trust_env=False,  # localhost must not go through the proxy
        )
        body = response.json()
    except Exception as e:  # noqa: BLE001
        return {"status": 0, "error": repr(e)}
    return {"status": response.status_code, **body}


def analyse(meeting: Meeting, minutes: dict, duration: float) -> list[dict]:
    """The checks a person watching the meeting would make."""
    findings: list[dict] = []

    def check(name: str, ok: bool | None, detail: str):
        findings.append({"check": name, "ok": ok, "detail": detail})

    steps = {s["id"]: s for s in meeting.steps}
    first = meeting.steps[0]["start"]
    segments = meeting.ear.segments
    speech = [s for s in segments if s[1] >= 1.0]
    blips = [s for s in segments if s[1] < 1.0]

    opening = [s for s in speech if s[0] < first]
    check("开场播报", bool(opening), f"{sum(s[1] for s in opening):.0f} 秒")

    off = steps.get("off_topic")
    warnings = [e for e in events if e["kind"] == "update:drift_warning"]
    if off:
        early = [w for w in warnings if first <= w["t"] < off["start"]]
        check("切题讨论未被打断", not early, f"{len(early)} 次误打断")
        hit = next((w for w in warnings if w["t"] >= off["start"]), None)
        if hit is None:
            check("跑题被打断", False, "没有发出打断")
        else:
            spoke = next((s for s in segments if s[0] >= hit["t"] - 1 and s[1] >= 1.0), None)
            check(
                "跑题被打断",
                spoke is not None,
                f"开始跑题后 {hit['t'] - off['start']:.1f} 秒提示（来源 {hit.get('source')}，"
                f"{hit.get('reason')}）；"
                + (
                    f"提示后 {spoke[0] - hit['t']:.1f} 秒开口，说了 {spoke[1]:.1f} 秒"
                    if spoke
                    else "主持人没有开口"
                ),
            )
            yielded = off.get("yielded_at")
            check(
                "跑题时被及时打断",
                hit["t"] - off["start"] <= 8 and yielded is not None,
                f"开始跑题后 {hit['t'] - off['start']:.1f} 秒发出提示；"
                + (
                    f"发言人在第 {yielded - off['start']:.1f} 秒被打断停下"
                    if yielded is not None
                    else f"发言人把 {off['speech_end'] - off['start']:.0f} 秒的话全部说完了"
                ),
            )
        later = [w for w in warnings if w["t"] > off["end"]]
        check("回到议题后没有再打断", not later, f"{len(later)} 次")

    chatter = [
        s for s in speech if first <= s[0] < (off["start"] if off else first)
    ]
    check(
        "正常讨论时保持安静",
        not chatter,
        f"插话 {len(chatter)} 次，共 {sum(s[1] for s in chatter):.0f} 秒",
    )

    decisions = list(meeting.decisions.values())
    repeats = [e for e in events if e["kind"] == "update:new_decision" and e["known"]]
    incomplete = [
        d["decision"]
        for d in decisions
        if not all(d.get(k) for k in ("owner", "dueDate", "verification", "evidence"))
    ]
    check(
        "决议登记",
        len(decisions) == 1 and not incomplete,
        f"{len(decisions)} 条，四要素不全 {len(incomplete)} 条，重复登记 {len(repeats)} 次",
    )

    required = [a["name"] for a in meeting.config["attendees"] if a.get("required")]
    called = [e.get("attendeeName", "") for e in events if e["kind"] == "update:roll_call"]
    missed = [n for n in required if not any(n in c for c in called)]
    check(
        "点名征询必须发言的人",
        not missed,
        f"点名 {len(called)} 次：{'、'.join(called) or '无'}"
        + (f"；没有点到 {'、'.join(missed)}" if missed else ""),
    )

    advances = [e for e in events if e["kind"] == "update:advance_agenda"]
    retried = [s["id"] for s in meeting.steps if s.get("retried")]
    check(
        "议程推进",
        [e.get("currentAgendaIndex") for e in advances] == [1] and not retried,
        f"推进 {len(advances)} 次：{[e.get('currentAgendaIndex') for e in advances]}"
        + ("；参会人要求了两次才有反应" if retried else ""),
    )

    check(
        "未决事项登记",
        len(meeting.open_items) == 1,
        f"{len(meeting.open_items)} 条"
        + "".join(f"；{o['issue']}（跟进：{o['owner'] or '缺'}）" for o in meeting.open_items),
    )

    wrap = steps.get("wrap_up")
    if wrap:
        closing = meeting.moderator_text_since(wrap["start"])
        check(
            "会议总结",
            bool(re.search(r"决议|未决", closing)),
            closing[:160] or "主持人没有总结",
        )

    overtime = [e for e in events if e["kind"] == "update:overtime_warning"]
    check("议题超时提醒", None, f"{len(overtime)} 次：{[e.get('title') for e in overtime]}")

    foreign = [
        s["text"]
        for s in meeting.transcript.values()
        if s["role"] == "moderator"
        and len(s["text"]) > 12
        and len(re.findall(r"[A-Za-z]", s["text"])) > len(s["text"]) * 0.5
    ]
    check("主持人全程说中文", not foreign, f"{len(foreign)} 段外语：{foreign[:2]}")

    check("短促杂音", None, f"{len(blips)} 次不足 1 秒的声音")

    stuck = [e for e in events if e["kind"] == "wait_reply_timeout"]
    check("主持人没有卡住", not stuck, f"等待超时 {len(stuck)} 次")

    moderator_seconds = sum(s[1] for s in speech)
    check(
        "发言占比",
        None,
        f"全程 {duration:.0f} 秒；参会人 {meeting.mic.spoken_seconds:.0f} 秒，"
        f"主持人 {moderator_seconds:.0f} 秒",
    )

    if minutes.get("status") == 200:
        m = minutes["minutes"]
        empty = [a["title"] for a in m["agendas"] if not a["discussionPoints"]]
        check(
            "AI 纪要",
            not empty,
            f"要点 {sum(len(a['discussionPoints']) for a in m['agendas'])} 条，"
            f"待确认事项 {len(m['actionItems'])} 条，时间线 {len(m['timeline'])} 条"
            + (f"；没有要点的议题：{empty}" if empty else ""),
        )
    else:
        check("AI 纪要", False, f"HTTP {minutes.get('status')}：{minutes.get('error')}")

    return findings


def write_report(out: Path, meeting: Meeting, findings: list[dict], minutes: dict):
    mark = {True: "通过", False: "**有问题**", None: "—"}
    lines = [
        f"# 模拟会议报告（{meeting.model}）",
        "",
        "| 检查项 | 结果 | 说明 |",
        "|---|---|---|",
        *(
            f"| {f['check']} | {mark[f['ok']]} | {f['detail'].replace('|', '/')} |"
            for f in findings
        ),
        "",
        "## 会议过程",
        "",
    ]
    rows = [
        (s["t"], "主持人" if s["role"] == "moderator" else "会场", s["text"])
        for s in meeting.transcript.values()
        if s["text"] and s["final"]
    ]
    rows += [
        (e["t"], "系统", f"{e['kind'][7:]} {json.dumps({k: v for k, v in e.items() if k not in ('t', 'kind')}, ensure_ascii=False)}")
        for e in events
        if e["kind"].startswith("update:") and e["kind"] != "update:state_sync"
    ]
    for t, who, text in sorted(rows):
        lines.append(f"- `{int(t) // 60:02d}:{int(t) % 60:02d}` **{who}** {text}")
    (out / "report.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


async def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--model", default="gemini-3.8-live")
    parser.add_argument(
        "--agent-name", default=os.environ.get("LIVEKIT_AGENT_NAME") or "smjar-dev"
    )
    parser.add_argument("--scenario", default=str(HERE / "scenario.json"))
    parser.add_argument("--web", default="http://localhost:3000")
    args = parser.parse_args()

    scenario = json.loads(Path(args.scenario).read_text(encoding="utf-8"))
    instructions = build_instructions(scenario["config"])
    lines = [(s["say"], s["text"]) for s in scenario["steps"]]
    lines += [(s["say"], s["retry"]) for s in scenario["steps"] if s.get("retry")]
    for key, answers in scenario["answers"].items():
        if key == "default":
            lines += [(name, answers) for name in scenario["voices"]]
        else:
            lines += list(answers.items())
    for speaker, text in lines:  # synthesise before the clock starts
        synthesize(scenario["voices"][speaker], text)

    global T0
    T0 = time.time()
    started_at_ms = int(T0 * 1000)
    meeting = Meeting(scenario, args.model, args.agent_name)
    await meeting.connect(instructions)
    await meeting.run()
    duration = now()

    minutes = await asyncio.to_thread(fetch_minutes, args.web, meeting, started_at_ms)
    findings = analyse(meeting, minutes, duration)

    out = RUNS / time.strftime("%Y%m%d-%H%M%S")
    out.mkdir(parents=True, exist_ok=True)
    (out / "events.json").write_text(
        json.dumps(
            {
                "model": args.model,
                "findings": findings,
                "steps": meeting.steps,
                "decisions": list(meeting.decisions.values()),
                "openItems": meeting.open_items,
                "minutes": minutes,
                "events": events,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    write_report(out, meeting, findings, minutes)
    if minutes.get("status") == 200:
        (out / "minutes.md").write_text(
            build_minutes(
                {
                    "config": meeting.config,
                    "liveState": {
                        "decisions": list(meeting.decisions.values()),
                        "openItems": meeting.open_items,
                        "currentAgendaIndex": meeting.agenda_index,
                    },
                    "elapsedSeconds": int(duration),
                    "now": started_at_ms,
                    "ai": minutes["minutes"],
                }
            ),
            encoding="utf-8",
        )

    print("\n==== 检查结果 ====")
    for f in findings:
        state = {True: "通过  ", False: "有问题", None: "  —   "}[f["ok"]]
        print(f"{state} {f['check']}: {f['detail']}")
    print(f"\n报告：{out}")
    return 0 if all(f["ok"] is not False for f in findings) else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
