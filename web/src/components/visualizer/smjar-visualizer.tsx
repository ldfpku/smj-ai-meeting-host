"use client";

import { SmjarMark } from "@/components/visualizer/smjar-mark";

import {
  AgentState,
  TrackReference,
  useTrackVolume,
} from "@livekit/components-react";

type SmjarVisualizerProps = {
  agentState: AgentState;
  agentTrackRef?: TrackReference;
};

export function SmjarVisualizer({
  agentTrackRef,
  agentState,
}: SmjarVisualizerProps) {
  const agentVolume = useTrackVolume(agentTrackRef);
  const disconnected = agentState === "disconnected";
  const volume = Math.min(agentVolume, 1);

  return (
    <div className="flex h-full w-full items-center justify-center relative">
      {/* 斯米伽蓝光晕衬在标志背后：主持人说话时随音量变亮、变大，未连接时熄灭。
          光晕只在标志后面，标志本身不加光、不加影（BIS B11）。 */}
      <div className="pointer-events-none absolute inset-0 z-0 flex items-center justify-center">
        <div
          className="h-[340px] w-[340px] rounded-full transition-all duration-150"
          style={{
            background:
              "radial-gradient(circle, var(--brand-glow) 0%, transparent 70%)",
            opacity: disconnected ? 0.35 : 0.65 + volume * 0.35,
            transform: `scale(${disconnected ? 0.8 : 0.9 + volume * 0.3})`,
          }}
        />
      </div>
      <SmjarMark volume={volume} state={agentState} />
    </div>
  );
}
