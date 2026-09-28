"use client";

import {
  LiveKitRoom,
  RoomAudioRenderer,
  StartAudio,
} from "@livekit/components-react";
import { useConnection } from "@/hooks/use-connection";
import { AgentProvider } from "@/hooks/use-agent";
import { useDemo } from "@/hooks/use-demo";
import { DemoHost } from "@/components/demo/demo-host";
import { ReactNode } from "react";

export function RoomWrapper({ children }: { children: ReactNode }) {
  const { shouldConnect, wsUrl, token } = useConnection();
  const demo = useDemo();

  return (
    <LiveKitRoom
      serverUrl={wsUrl}
      token={token}
      connect={shouldConnect}
      // 演示会议里的发言是合成语音，不采集真实麦克风
      audio={!demo.active}
      className="flex w-full h-screen"
      options={{
        publishDefaults: {
          stopMicTrackOnMute: true,
        },
      }}
    >
      <AgentProvider>
        {children}
        <DemoHost />
        <RoomAudioRenderer />
        <StartAudio label="点击以允许播放音频" />
      </AgentProvider>
    </LiveKitRoom>
  );
}

