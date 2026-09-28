"use client";

import React, { useEffect, useRef } from "react";
import {
  CheckCircle2,
  CircleDashed,
  HelpCircle,
  Loader2,
  Square,
  Volume2,
  X,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useDemo } from "@/hooks/use-demo";
import { DEMO_CONFIG, DEMO_STEPS, DEMO_VOICES } from "@/data/demo-meeting";

function clock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  return `${Math.floor(total / 60)
    .toString()
    .padStart(2, "0")}:${(total % 60).toString().padStart(2, "0")}`;
}

const statusText = {
  idle: "",
  preparing: "正在合成各位参会人的发言",
  connecting: "正在进入会议，等待主持人就位",
  running: "会议进行中",
  done: "演示结束",
};

/** 演示会议的面板：谁在说话、这一步要看什么、最后的检查结果。 */
export function DemoPanel({ className = "" }: { className?: string }) {
  const { status, progress, line, events, findings, stop, close } = useDemo();
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events, findings]);

  const spoken = new Set(
    events.map((e) => DEMO_STEPS.find((s) => s.text === e.text)?.id)
  );
  const failed = findings.filter((f) => f.ok === false).length;
  const busy = status === "preparing" || status === "connecting";

  return (
    <div
      className={`flex flex-col min-h-0 w-full bg-card/60 backdrop-blur-md rounded-xl border border-blue-500/40 shadow-sm ${className}`}
    >
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-border/60">
        <div className="flex items-center gap-1.5 text-xs font-semibold min-w-0">
          {busy || status === "running" ? (
            <Loader2 className="w-3.5 h-3.5 text-blue-500 animate-spin flex-shrink-0" />
          ) : (
            <CheckCircle2 className="w-3.5 h-3.5 text-blue-500 flex-shrink-0" />
          )}
          <span className="truncate">
            演示会议：{DEMO_CONFIG.topic}
            <span className="font-normal text-muted-foreground">
              　{statusText[status]}
              {status === "preparing" && progress.total > 0
                ? `（${progress.done}/${progress.total}）`
                : ""}
              {status === "done" && findings.length > 0
                ? failed
                  ? `，${failed} 项没有通过`
                  : "，各项检查都通过了"
                : ""}
            </span>
          </span>
        </div>
        {status === "done" ? (
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-xs gap-1"
            onClick={close}
            title="关闭演示，恢复原来的会议配置"
          >
            <X className="w-3 h-3" />
            关闭演示
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            className="h-6 px-2 text-xs gap-1"
            onClick={stop}
          >
            <Square className="w-3 h-3" />
            停止
          </Button>
        )}
      </div>

      <div className="px-3 py-2 border-b border-border/60 text-xs min-h-[64px]">
        {line ? (
          <>
            <div className="flex items-center gap-1.5 font-semibold text-blue-600 dark:text-blue-400">
              <Volume2 className="w-3.5 h-3.5" />
              {line.speaker}
              <span className="font-normal text-muted-foreground">
                （{DEMO_VOICES[line.speaker]} 音色）正在发言
              </span>
            </div>
            <div className="mt-1 text-foreground/90 leading-relaxed line-clamp-2">
              {line.text}
            </div>
            <div className="mt-1 text-[11px] text-muted-foreground">
              看点：{line.watch}
            </div>
          </>
        ) : (
          <div className="text-muted-foreground leading-relaxed">
            {status === "running"
              ? "现在轮到主持人说话。"
              : status === "done"
              ? "参会人的发言由合成语音扮演，主持人、跑题检测、看板和转写都是真实运行的。"
              : "四位参会人由不同音色的合成语音扮演，会议全程自动进行，大约 4 分钟。"}
          </div>
        )}
      </div>

      <div
        ref={logRef}
        className="flex-1 min-h-0 overflow-y-auto px-3 py-2 space-y-1 text-[11px] leading-relaxed"
      >
        {findings.length > 0 ? (
          findings.map((f) => (
            <div key={f.name} className="flex items-start gap-1.5">
              {f.ok === true ? (
                <CheckCircle2 className="w-3.5 h-3.5 mt-px text-emerald-500 flex-shrink-0" />
              ) : f.ok === false ? (
                <XCircle className="w-3.5 h-3.5 mt-px text-red-500 flex-shrink-0" />
              ) : (
                <HelpCircle className="w-3.5 h-3.5 mt-px text-muted-foreground flex-shrink-0" />
              )}
              <span>
                <strong className="font-semibold">{f.name}</strong>
                <span className="text-muted-foreground">：{f.detail}</span>
              </span>
            </div>
          ))
        ) : (
          <>
            {DEMO_STEPS.map((s) => (
              <div
                key={s.id}
                className={`flex items-start gap-1.5 ${
                  line?.stepId === s.id
                    ? "text-foreground"
                    : spoken.has(s.id)
                    ? "text-muted-foreground/60"
                    : "text-muted-foreground"
                }`}
              >
                {spoken.has(s.id) && line?.stepId !== s.id ? (
                  <CheckCircle2 className="w-3 h-3 mt-0.5 flex-shrink-0" />
                ) : (
                  <CircleDashed className="w-3 h-3 mt-0.5 flex-shrink-0" />
                )}
                <span className="truncate">
                  {s.say}：{s.watch}
                </span>
              </div>
            ))}
            {events
              .filter((e) => !DEMO_VOICES[e.kind] && e.kind !== "主持人")
              .slice(-4)
              .map((e, i) => (
                <div key={`${e.t}-${i}`} className="text-muted-foreground">
                  <span className="tabular-nums">{clock(e.t)}</span>　{e.kind}
                  {e.text ? `：${e.text}` : ""}
                </div>
              ))}
          </>
        )}
      </div>
    </div>
  );
}
