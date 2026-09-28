"use client";

import { useEffect, useRef } from "react";
import {
  useConnectionState,
  useRoomContext,
  useVoiceAssistant,
} from "@livekit/components-react";
import { ConnectionState, Track } from "livekit-client";
import { useDemo } from "@/hooks/use-demo";
import { DemoRunner } from "@/lib/demo/runner";

/**
 * 演示会议与房间之间的接线：主持人就位后，把合成语音当作麦克风发布出去，
 * 然后开始按台词开会。不渲染任何内容。
 */
export function DemoHost() {
  const room = useRoomContext();
  const connectionState = useConnectionState();
  const { agent } = useVoiceAssistant();
  const { status, audio, attach, stop, callbacks } = useDemo();
  const startedRef = useRef(false);
  const wasConnectedRef = useRef(false);

  useEffect(() => {
    if (status === "idle" || status === "done") {
      startedRef.current = false;
      wasConnectedRef.current = false;
    }
  }, [status]);

  useEffect(() => {
    if (status !== "connecting" || !audio) return;

    if (connectionState === ConnectionState.Connected) {
      wasConnectedRef.current = true;
    } else if (
      connectionState === ConnectionState.Disconnected &&
      wasConnectedRef.current
    ) {
      // 进了房间又掉出来（例如主持人一直没来）：演示到此为止
      stop();
      return;
    }

    if (
      connectionState !== ConnectionState.Connected ||
      !agent ||
      startedRef.current
    ) {
      return;
    }
    startedRef.current = true;

    (async () => {
      await audio.resume();
      await room.localParticipant.publishTrack(audio.track, {
        source: Track.Source.Microphone,
        name: "demo-mic",
      });
      attach(new DemoRunner(room, audio, agent, callbacks));
    })().catch((err) => {
      console.error("[demo] could not start", err);
      stop();
    });
  }, [status, audio, connectionState, agent, room, attach, stop, callbacks]);

  return null;
}
