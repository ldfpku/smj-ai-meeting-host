"""Simulated meeting: runs the moderator through a whole meeting, unattended.

Several people (one synthetic voice each) talk into the one microphone of a
meeting room, the way the product is used. The script only speaks; everything
the assistant does (prompting the chair, recording decisions, noting that the
agenda moved on, the summary) has to happen on its own, and what it must NOT do
(open the meeting, call people one by one) is checked too. Afterwards the minutes are generated and a
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
HEAR_MODEL = "gemini-3.5-transcribe"

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


def hear(pcm: bytes, rate: int) -> str:
    """What a listener hears in a piece of the moderator's audio. The text the
    Live model reports is what it meant to say, which is not always the same:
    it has been heard saying 总理 where its text said 总经理."""
    wav = BytesIO()
    with wave.open(wav, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm)
    response = httpx.post(
        TTS_ENDPOINT,
        headers={"x-goog-api-key": os.environ["GEMINI_API_KEY"]},
        json={
            "model": HEAR_MODEL,
            "input": [
                {
                    "type": "audio",
                    "data": base64.b64encode(wav.getvalue()).decode("ascii"),
                    "mime_type": "audio/wav",
                }
            ],
            "generation_config": {
                "transcription_config": {
                    "mode": {"type": "verbatim"},
                    "language_codes": ["cmn-Hans-CN"],
                }
            },
        },
        timeout=120,
    )
    response.raise_for_status()
    body = response.json()
    if body.get("output_text"):
        return body["output_text"].strip()
    texts = [
        part.get("text", "")
        for step in body.get("steps", [])
        for part in step.get("content") or []
        if part.get("type") == "text"
    ]
    return "".join(texts).strip()


def with_call_names(config: dict) -> dict:
    """The web app adds the call names (李总, 王部长) when the configuration is
    saved; the simulation has to do the same, with the real code."""
    out = run_node(
        "const [dir, file] = process.argv.slice(1);"
        "const h = require(dir + '/honorifics.js');"
        "const c = JSON.parse(require('fs').readFileSync(file, 'utf8'));"
        "process.stdout.write(JSON.stringify(h.withCallNames(c)));",
        config,
    )
    return json.loads(out)


def compile_web_data() -> Path:
    """The moderator prompt and the minutes template live in the web app
    (TypeScript). They are compiled once so the simulation uses the real ones."""
    out = CACHE / "js"
    sources = [
        ROOT / "web/src/data" / n
        for n in ("meeting.ts", "meeting-minutes.ts", "honorifics.ts")
    ]
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
        #: what the moderator said, as sound: (start, seconds, pcm, rate)
        self.recordings: list[tuple[float, float, bytes, int]] = []

    async def listen(self, track: rtc.Track):
        # each track is recorded by itself: the moderator has two
        tape = bytearray()
        tape_from = 0.0
        tape_loud = 0.0
        async for ev in rtc.AudioStream(track):
            data = bytes(ev.frame.data)
            samples = array.array("h", data)
            if not samples:
                continue
            rms = math.sqrt(sum(s * s for s in samples) / len(samples))
            t = time.time()
            if rms > 300:
                if not tape:
                    tape_from = t
                tape_loud = t
            if tape or rms > 300:
                tape.extend(data)
                if t - tape_loud > 0.7:
                    seconds = tape_loud - tape_from
                    if seconds >= 1.0:
                        self.recordings.append(
                            (tape_from - T0, seconds, bytes(tape), ev.frame.sample_rate)
                        )
                    tape = bytearray()
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
        self.config = with_call_names(scenario["config"])
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
        self.chair_confirms = False
        self.heard: list[dict] = []

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
        if kind == "drift_suggestion" and self.chair_confirms:
            self.chair_confirms = False
            self.tasks.append(asyncio.create_task(self.confirm_as_chair(dict(data))))
        log(f"update:{kind}", **data)

    async def confirm_as_chair(self, suggestion: dict):
        """The chair clicks 请会议助手提醒 on the board: the same RPC as the button."""
        log("chair_confirms", suggestion=suggestion.get("suggestionId"))
        try:
            await self.room.local_participant.perform_rpc(
                destination_identity=self.agent_identity,
                method="pg.forceIntervene",
                payload=json.dumps(
                    {
                        "suggestionId": suggestion.get("suggestionId"),
                        "reason": suggestion.get("reason"),
                    },
                    ensure_ascii=False,
                ),
            )
        except Exception as e:  # noqa: BLE001
            log("chair_confirm_failed", error=repr(e))

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

    async def floor_to_moderator(self):
        await self.wait_reply()

    async def run(self):
        # the assistant does not open a meeting: a few quiet seconds first
        await asyncio.sleep(6)
        log("quiet_opening_done")

        for step in self.scenario["steps"]:
            record = {"id": step["id"], "start": now(), "expect": step.get("expect")}
            self.steps.append(record)
            agenda_before = self.agenda_index
            if step.get("until") == "advance" and agenda_before > 0:
                # the agenda has moved on: nobody needs to ask
                record["skipped"] = True
                record["end"] = now()
                log("step_skipped", step=step["id"])
                continue
            self.chair_confirms = step.get("expect") == "suggest"
            record["yielded_at"] = await self.say(
                step["say"],
                step["text"],
                step["id"],
                yields=step.get("expect") in ("suggest", "interrupt"),
            )
            self.chair_confirms = False
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

        # the closing summary is announced by the system, a moment later
        asked = self.steps[-1]["start"] if self.steps else now()
        for _ in range(200):
            if "请主持人确认" in self.moderator_text_since(asked):
                await self.wait_reply(min_wait=1.0)
                break
            await asyncio.sleep(0.1)

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
    invite = steps.get("invite")
    segments = meeting.ear.segments
    speech = [s for s in segments if s[1] >= 1.0]
    blips = [s for s in segments if s[1] < 1.0]

    # the assistant does not open: silent until the chair speaks, reads the
    # agenda when invited, and hands the floor back
    before = [s for s in speech if s[0] < first]
    check(
        "不抢着开场",
        not before,
        "主持人开口之前，会议助手一直安静"
        if not before
        else f"主持人还没开口，会议助手先说了 {sum(s[1] for s in before):.0f} 秒",
    )
    if invite:
        nxt = steps.get("problem")
        read = meeting.moderator_text_since(invite["start"])
        if nxt:
            read = " ".join(
                s["text"]
                for s in sorted(meeting.transcript.values(), key=lambda s: s["t"])
                if s["role"] == "moderator" and invite["start"] <= s["t"] < nxt["start"]
            )
        first_title = meeting.config["agendas"][0]["title"]
        # spoken as "三号", written "3 号": compare the part without the number
        title_key = re.sub(r"^[0-9一二三四五六七八九十]+\s*号", "", first_title).replace(" ", "")
        check(
            "被邀请后播报议程",
            title_key in read.replace(" ", ""),
            read[:120] or "会议助手没有播报",
        )
        check(
            "不宣布讨论开始",
            not re.search(r"讨论正式开始|现在开始讨论", read),
            "播报完把话交还给了主持人" if not re.search(r"讨论正式开始|现在开始讨论", read) else read[:120],
        )

    off = steps.get("off_topic")
    suggestions = [e for e in events if e["kind"] == "update:drift_suggestion"]
    warnings = [e for e in events if e["kind"] == "update:drift_warning"]
    if off:
        early = [w for w in suggestions + warnings if first <= w["t"] < off["start"]]
        check("切题讨论未被提示", not early, f"{len(early)} 次误提示")
        hit = next((w for w in suggestions if w["t"] >= off["start"]), None)
        check(
            "跑题先提示主持人",
            hit is not None,
            f"开始跑题后 {hit['t'] - off['start']:.1f} 秒，看板提示了主持人（来源 {hit.get('source')}，{hit.get('reason')}）"
            if hit
            else "没有出现提示",
        )
        if hit is not None:
            talked = [s for s in segments if off["start"] <= s[0] < hit["t"] and s[1] >= 1.0]
            check(
                "采纳之前不开口",
                not talked,
                "会议助手等主持人点了采纳才开口" if not talked else "没等主持人采纳就开了口",
            )
        warn = next((w for w in warnings if w["t"] >= off["start"]), None)
        spoke = (
            next((s for s in segments if s[0] >= warn["t"] - 1 and s[1] >= 1.0), None)
            if warn
            else None
        )
        yielded = off.get("yielded_at")
        check(
            "采纳后提醒并让发言人停下",
            spoke is not None and yielded is not None,
            (
                f"采纳后 {spoke[0] - warn['t']:.1f} 秒开口，说了 {spoke[1]:.1f} 秒；"
                if spoke
                else "采纳后会议助手没有开口；"
            )
            + (
                f"发言人在第 {yielded - off['start']:.1f} 秒停下"
                if yielded is not None
                else f"发言人把 {off['speech_end'] - off['start']:.0f} 秒的话全部说完了"
            ),
        )
        said = meeting.moderator_text_since(off["start"])
        chair_call = meeting.config.get("chairCallName") or "主持人"
        check(
            "提醒是对主持人说的",
            bool(re.search(chair_call + "|主持人", said[:80])) and "各位，先停" not in said[:80],
            said[:100] or "没有收到会议助手的话",
        )
        later = [w for w in warnings if w["t"] > off["end"]]
        check("回到议题后没有再提醒", not later, f"{len(later)} 次")

    chatter = [
        s
        for s in speech
        if (invite["end"] if invite else first) <= s[0] < (off["start"] if off else first)
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

    called = [e.get("attendeeName", "") for e in events if e["kind"] == "update:roll_call"]
    check(
        "没有逐个点名",
        not called,
        "整场没有点名" if not called else f"点名 {len(called)} 次：{'、'.join(called)}",
    )

    advances = [e for e in events if e["kind"] == "update:advance_agenda"]
    retried = [s["id"] for s in meeting.steps if s.get("retried")]
    check(
        "记录议程推进",
        [e.get("currentAgendaIndex") for e in advances] == [1] and not retried,
        f"推进 {len(advances)} 次：{[e.get('currentAgendaIndex') for e in advances]}"
        + ("；参会人说了两次才有反应" if retried else ""),
    )
    close = steps.get("close_1")
    plan = steps.get("plan")
    if close and plan:
        # judged by the sound, not by the transcript: a short "好，下面讨论……"
        # is an announcement too
        spoke = [
            seg
            for seg in segments
            if close["speech_end"] <= seg[0] < plan["start"] and seg[1] >= 1.0
        ]
        check(
            "推进时不口头宣布",
            not spoke,
            "看板同步了，会议助手没有出声"
            if not spoke
            else f"会议助手出声 {sum(x[1] for x in spoke):.0f} 秒："
            + meeting.moderator_text_since(close["speech_end"])[:80],
        )

    check(
        "未决事项登记",
        len(meeting.open_items) == 1,
        f"{len(meeting.open_items)} 条"
        + "".join(f"；{o['issue']}（跟进：{o['owner'] or '缺'}）" for o in meeting.open_items),
    )

    wrap = steps.get("wrap_up")
    if wrap:
        # a moderator that sums up before it is asked has done its job
        before = meeting.steps[max(0, meeting.steps.index(wrap) - 1)]
        closing = meeting.moderator_text_since(before["start"])
        check(
            "会议小结（请主持人确认，不宣布散会）",
            bool(re.search(r"决议|未决", closing))
            and "请主持人确认" in closing
            and "会议到此结束" not in closing,
            closing[:160] or "会议助手没有做小结",
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
    check("会议助手全程说中文", not foreign, f"{len(foreign)} 段外语：{foreign[:2]}")

    check("短促杂音", None, f"{len(blips)} 次不足 1 秒的声音")

    # what was said against what was meant
    written = " ".join(
        s["text"] for s in meeting.transcript.values() if s["role"] == "moderator"
    )
    heard = " ".join(h["text"] for h in meeting.heard)
    terms = [t for t in meeting.scenario.get("pronounce", []) if t in written]
    wrong = [t for t in terms if written.count(t) > heard.count(t)]
    check(
        "念出来的与文字一致",
        (not wrong) if meeting.heard and terms else None,
        "；".join(
            f"「{t}」文字里 {written.count(t)} 次，听到 {heard.count(t)} 次" for t in terms
        )
        or "没有可核对的词",
    )

    stuck = [e for e in events if e["kind"] == "wait_reply_timeout"]
    check("会议助手没有卡住", not stuck, f"等待超时 {len(stuck)} 次")

    moderator_seconds = sum(s[1] for s in speech)
    check(
        "发言占比",
        None,
        f"全程 {duration:.0f} 秒；参会人 {meeting.mic.spoken_seconds:.0f} 秒，"
        f"会议助手 {moderator_seconds:.0f} 秒",
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
    elif minutes.get("code") == "MISSING_API_KEY":
        check("AI 纪要", None, "本地开发服务器没有 Cloudflare AI 绑定，已跳过（发布后在线上验证）")
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
    instructions = build_instructions(with_call_names(scenario["config"]))
    lines = [(s["say"], s["text"]) for s in scenario["steps"]]
    lines += [(s["say"], s["retry"]) for s in scenario["steps"] if s.get("retry")]
    for speaker, text in lines:  # synthesise before the clock starts
        synthesize(scenario["voices"][speaker], text)

    global T0
    T0 = time.time()
    started_at_ms = int(T0 * 1000)
    meeting = Meeting(scenario, args.model, args.agent_name)
    await meeting.connect(instructions)
    await meeting.run()
    duration = now()

    for start, seconds, pcm, rate in sorted(meeting.ear.recordings):
        try:
            text = await asyncio.to_thread(hear, pcm, rate)
        except Exception as e:  # noqa: BLE001
            text = ""
            print(f"could not transcribe the moderator at {start:.0f}s: {e!r}")
        meeting.heard.append({"t": round(start, 1), "seconds": round(seconds, 1), "text": text})
        print(f"[{start:7.2f}] heard                {text}"[:240], flush=True)

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
                "heard": meeting.heard,
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
