"use client";

import React from "react";
import { AgentState } from "@livekit/components-react";

/**
 * SMJ 标志动画：完整的 S（上钩信号橙、下钩斯米伽蓝），按标志文件原样绘制。
 *
 * 遵守 BIS B11：标志不旋转、不倾斜、不加投影与渐变、不降透明度、不改钩的错位，
 * 因此不用三维，也不让它变暗。允许的只有等比缩放与平移：
 *  - 主持人说话时随音量等比放大一点，背后的光晕（见 smjar-visualizer）随之变亮；
 *  - 连接中轻轻上下浮动；
 *  - 未连接时沉下去一点、略小，颜色不变。
 * 两条路径取自品牌库 01_Logo/SVG/smj-symbol-color.svg（viewBox 108×124）。
 */
export const SmjarMark = ({
  volume,
  state,
}: {
  volume: number;
  state: AgentState;
}) => {
  const disconnected = state === "disconnected";
  const scale = disconnected ? 0.85 : 1 + Math.min(volume, 1) * 0.25;

  return (
    <div
      className="relative z-10 flex items-center justify-center"
      style={{
        transform: `translateY(${disconnected ? 24 : 0}px) scale(${scale})`,
        transition: "transform 150ms ease-out",
      }}
    >
      <svg
        viewBox="0 0 108 124"
        role="img"
        aria-label="SMJ"
        className={`h-40 w-auto ${disconnected ? "" : "smj-mark-float"}`}
      >
        <path
          fill="#FA8C1F"
          d="M108 0H35A35 35 0 0 0 0 35A35 35 0 0 0 35 70H50.5V46H35A11 11 0 0 1 24 35A11 11 0 0 1 35 24H108Z"
        />
        <path
          fill="#034FBC"
          d="M0 124H73A35 35 0 0 0 108 89A35 35 0 0 0 73 54H57.5V78H73A11 11 0 0 1 84 89A11 11 0 0 1 73 100H0Z"
        />
      </svg>
    </div>
  );
};
