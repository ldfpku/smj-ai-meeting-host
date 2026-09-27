"use client";

import React, { useEffect, useRef, useState } from "react";
import { MessagesSquare } from "lucide-react";
import type { TranscriptEntry } from "@/hooks/use-agent";

interface TranscriptPanelProps {
  transcript: Pick<TranscriptEntry, "id" | "role" | "text" | "final" | "at">[];
  /** 会议开始时间，用于显示"会议开始后 mm:ss" */
  startedAt?: number | null;
  className?: string;
}

function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

/** 实时转写。只显示、不可编辑；校对在生成纪要时进行。 */
export function TranscriptPanel({
  transcript,
  startedAt,
  className = "",
}: TranscriptPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // 用户往回翻看时不要把他拽回底部
  const [stickToBottom, setStickToBottom] = useState(true);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom) el.scrollTop = el.scrollHeight;
  }, [transcript, stickToBottom]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    setStickToBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
  };

  const origin = startedAt ?? transcript[0]?.at ?? 0;

  return (
    <div
      className={`flex flex-col min-h-0 w-full bg-card/60 backdrop-blur-md rounded-xl border border-border/80 shadow-sm ${className}`}
    >
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-border/60">
        <div className="flex items-center gap-1.5 text-xs font-semibold">
          <MessagesSquare className="w-3.5 h-3.5 text-blue-500" />
          <span>实时转写</span>
          {transcript.length > 0 && (
            <span className="font-normal text-muted-foreground">
              {transcript.length} 段
            </span>
          )}
        </div>
        <span
          className="text-[10px] text-muted-foreground"
          title="当前语音模型不支持说话人分离，所有参会人的发言都记在「会场」名下"
        >
          暂不区分发言人 · 已保存在本机
        </span>
      </div>

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 min-h-0 overflow-y-auto px-3 py-2 space-y-2"
      >
        {transcript.length === 0 ? (
          <div className="h-full flex items-center justify-center text-center text-xs text-muted-foreground/70 py-6">
            会议开始后，发言内容会实时显示在这里
          </div>
        ) : (
          transcript.map((entry) => {
            const isModerator = entry.role === "moderator";
            return (
              <div key={entry.id} className="text-xs leading-relaxed">
                <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground mb-0.5">
                  <span
                    className={`px-1.5 py-px rounded font-medium ${
                      isModerator
                        ? "bg-blue-500/10 text-blue-600 dark:text-blue-400"
                        : "bg-muted text-muted-foreground"
                    }`}
                  >
                    {isModerator ? "主持人" : "会场"}
                  </span>
                  <span>{clock(entry.at - origin)}</span>
                </div>
                <div
                  className={
                    entry.final ? "text-foreground/90" : "text-foreground/60"
                  }
                >
                  {entry.text}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
