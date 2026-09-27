"use client";

import React, { useEffect, useState } from "react";
import { Copy, Download, Loader2, Sparkles } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import type { MeetingConfig, MeetingLiveState } from "@/data/meeting";
import {
  AiMinutes,
  generateMinutesMarkdown,
  minutesFileName,
} from "@/data/meeting-minutes";

export interface MinutesSource {
  config: MeetingConfig;
  liveState: Pick<
    MeetingLiveState,
    "decisions" | "openItems" | "currentAgendaIndex"
  >;
  elapsedSeconds: number;
  transcript: { role: string; text: string; at: number }[];
  startedAt: number | null;
}

interface MinutesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 打开时才读取，保证拿到的是最新的会议状态与转写 */
  getSource: () => MinutesSource | Promise<MinutesSource>;
}

/**
 * 纪要草稿：记录人手动触发 AI 整理 → 在这里校对修改 → 复制或导出。
 * AI 调用失败时草稿保持为模板纪要，照常可以编辑和导出。
 */
export function MinutesDialog({
  open,
  onOpenChange,
  getSource,
}: MinutesDialogProps) {
  const { toast } = useToast();
  const [source, setSource] = useState<MinutesSource | null>(null);
  const [draft, setDraft] = useState("");
  const [edited, setEdited] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [usedAi, setUsedAi] = useState(false);
  const [aiSource, setAiSource] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setError(null);
    setNotice(null);
    setEdited(false);
    setUsedAi(false);
    setAiSource("");
    Promise.resolve(getSource()).then((loaded) => {
      if (cancelled) return;
      setSource(loaded);
      setDraft(generateMinutesMarkdown(loaded));
    });
    return () => {
      cancelled = true;
    };
    // getSource 每次渲染都是新函数；只在打开时读取一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const handleGenerate = async () => {
    if (!source) return;
    setGenerating(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/minutes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          config: source.config,
          decisions: source.liveState.decisions,
          openItems: source.liveState.openItems,
          transcript: source.transcript,
          startedAt: source.startedAt,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.minutes) {
        throw new Error(data.error || `AI 纪要生成失败（HTTP ${response.status}）。`);
      }
      const producedBy = data.providerLabel
        ? `${data.providerLabel}（${data.model}）`
        : "";
      setDraft(
        generateMinutesMarkdown({
          ...source,
          ai: data.minutes as AiMinutes,
          aiSource: producedBy || undefined,
        })
      );
      setEdited(false);
      setUsedAi(true);
      setAiSource(producedBy);
      const skipped = Array.isArray(data.fallbackFrom) ? data.fallbackFrom : [];
      if (skipped.length > 0) {
        setNotice(
          skipped
            .map(
              (f: { providerLabel: string; error: string }) =>
                `${f.providerLabel}没有成功（${f.error}）`
            )
            .join("；") + `，这次改由 ${producedBy} 整理。`
        );
      }
    } catch (err) {
      setError(
        (err instanceof Error ? err.message : "AI 纪要生成失败。") +
          " 草稿保持不变，仍可手动编辑后导出。"
      );
    } finally {
      setGenerating(false);
    }
  };

  const handleCopy = async () => {
    await navigator.clipboard.writeText(draft);
    toast({
      title: "会议纪要已复制到剪贴板",
      description: "含决议四要素、未决事项与回执确认栏。",
    });
  };

  const handleDownload = () => {
    if (!source) return;
    const blob = new Blob([draft], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = minutesFileName(source.config);
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast({
      title: "会议纪要已导出",
      description: "可直接发给参会人做回执确认。",
    });
  };

  const transcriptCount = source?.transcript.length ?? 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[92vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>会议纪要草稿</DialogTitle>
          <DialogDescription>
            点击「生成 AI 纪要」，由 AI 根据转写整理讨论要点、待确认事项和时间线；
            校对修改后再复制或导出。决议与未决事项始终以会上登记的记录为准。
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-xs text-muted-foreground">
            {transcriptCount > 0
              ? `本场会议共 ${transcriptCount} 段转写`
              : "本场会议没有转写，只能导出模板纪要"}
            {usedAi &&
              ` · 当前草稿含 AI 整理内容${
                aiSource ? `（${aiSource}）` : ""
              }，请校对`}
          </div>
          <Button
            size="sm"
            onClick={handleGenerate}
            disabled={generating || !source || transcriptCount === 0}
            className="gap-1.5"
            title={
              edited ? "重新生成会覆盖你在草稿里的修改" : "根据会议转写生成"
            }
          >
            {generating ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Sparkles className="w-3.5 h-3.5" />
            )}
            {generating
              ? "正在整理…"
              : edited
              ? "重新生成（覆盖修改）"
              : usedAi
              ? "重新生成"
              : "生成 AI 纪要"}
          </Button>
        </div>

        {error && (
          <div className="text-xs text-destructive bg-destructive/10 p-2.5 rounded-md">
            {error}
          </div>
        )}
        {notice && (
          <div className="text-xs text-amber-600 dark:text-amber-400 bg-amber-500/10 p-2.5 rounded-md">
            {notice}
          </div>
        )}

        <Textarea
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setEdited(true);
          }}
          spellCheck={false}
          className="flex-1 min-h-[48vh] font-mono text-xs leading-relaxed resize-none"
          aria-label="会议纪要草稿（Markdown）"
        />

        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" onClick={handleCopy} className="gap-1.5">
            <Copy className="w-3.5 h-3.5" />
            复制
          </Button>
          <Button onClick={handleDownload} className="gap-1.5">
            <Download className="w-3.5 h-3.5" />
            导出 Markdown
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
