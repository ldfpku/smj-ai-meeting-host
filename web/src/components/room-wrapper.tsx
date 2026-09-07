"use client";

import {
  LiveKitRoom,
  RoomAudioRenderer,
  StartAudio,
} from "@livekit/components-react";
import { useConnection } from "@/hooks/use-connection";
import { AgentProvider } from "@/hooks/use-agent";
import { ReactNode } from "react";

export function RoomWrapper({ children }: { children: ReactNode }) {
  const { shouldConnect, wsUrl, token } = useConnection();

  return (
    <LiveKitRoom
      serverUrl={wsUrl}
      token={token}
      connect={shouldConnect}
      audio={true}
      className="flex w-full h-screen"
      options={{
        publishDefaults: {
          stopMicTrackOnMute: true,
        },
      }}
    >
      <AgentProvider>
        {children}
        <RoomAudioRenderer />
        <StartAudio label="点击以允许播放音频" />
      </AgentProvider>
    </LiveKitRoom>
  );
}

