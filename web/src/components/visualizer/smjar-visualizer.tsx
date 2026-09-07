"use client";

import Image from "next/image";
import { SmjarMark } from "@/components/visualizer/smjar-mark";
import { useTheme } from "next-themes";

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
  const { theme, resolvedTheme } = useTheme();
  const currentTheme = theme === "system" ? resolvedTheme : theme;

  return (
    <div
      className="flex h-full w-full items-center justify-center relative"
      style={{
        perspective: "1000px",
      }}
    >
      {/* 品牌辉光衬底：让地球落在同色系的光晕里，而不是浮在纯色背景上 */}
      <div className="pointer-events-none absolute inset-0 z-0 flex items-center justify-center">
        <div
          className="h-[340px] w-[340px] rounded-full"
          style={{
            background:
              "radial-gradient(circle, var(--brand-glow) 0%, transparent 70%)",
          }}
        />
      </div>

      {/* 背景水印：品牌水印图（透明底、低不透明度，专为平铺/衬底设计） */}
      <div className="absolute z-0 left-1/2 top-1/4 -translate-x-1/2 -translate-y-10 opacity-[0.06] pointer-events-none">
        <Image
          src="/static/brand/watermark.webp"
          alt=""
          aria-hidden
          width={160}
          height={160}
          className="h-40 w-40 object-contain"
        />
      </div>
      <SmjarMark volume={agentVolume} state={agentState} />
      <Shadow volume={agentVolume} state={agentState} theme={currentTheme} />
    </div>
  );
}

const Shadow = ({
  volume,
  state,
  theme,
}: {
  volume: number;
  state?: AgentState;
  theme?: string;
}) => {
  const disconnectedOpacity = theme === "light" ? 0.15 : 0.2;
  const idleOpacity = theme === "light" ? 0.12 : 0.15;

  return (
    <div
      className="absolute z-0"
      style={{
        transform: "translateY(140px) rotate3d(1, 0, 0, 80deg)",
        transformStyle: "preserve-3d",
        zIndex: -1,
      }}
    >
      <div
        className="absolute w-[200px] h-[100px] transition-all duration-150 left-1/2 top-1/2 rounded-full bg-brand-green"
        style={{
          transform: `translate(-50%, calc(-50% + 50px)) scale(${
            state === "disconnected" ? 0.6 : 0.75 + volume * 0.1
          })`,
          filter: `blur(30px) ${
            state === "disconnected" ? "saturate(0.3)" : "saturate(1.0)"
          }`,
          opacity:
            state === "disconnected"
              ? disconnectedOpacity
              : volume > 0
              ? 0.4
              : idleOpacity,
        }}
      ></div>
    </div>
  );
};
