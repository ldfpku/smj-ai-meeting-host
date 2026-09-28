"use client";

import React, { useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardPaste,
  FileUp,
  Loader2,
  Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  DOCUMENT_ACCEPT,
  DocumentError,
  readDocumentFile,
} from "@/lib/document-text";
import type { ImportedMeeting } from "@/lib/meeting-import";

interface ImportResponse {
  meeting?: ImportedMeeting;
  warnings?: string[];
  model?: string;
  error?: string;
}

interface Outcome {
  source: string;
  agendas: number;
  attendees: number;
  model: string;
  warnings: string[];
}

/**
 * 从文档导入会议配置：选一个 md / docx 文件，或粘贴文字，由模型整理成标准格式。
 * 整理结果只填进配置弹窗，组织者核对后点"确认并保存"才生效。
 */
export function MeetingImport({
  onImported,
}: {
  onImported: (meeting: ImportedMeeting) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [pasting, setPasting] = useState(false);
  const [pasted, setPasted] = useState("");
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const convert = async (text: string, source: string, fileName?: string) => {
    setWorking(`正在整理${source}，一般需要十几秒……`);
    const response = await fetch("/api/meeting-import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, fileName }),
    });
    const data: ImportResponse = await response.json().catch(() => ({}));
    if (!response.ok || !data.meeting) {
      throw new DocumentError(
        data.error || `整理失败（HTTP ${response.status}），请稍后再试。`
      );
    }
    onImported(data.meeting);
    setOutcome({
      source,
      agendas: data.meeting.agendas.length,
      attendees: data.meeting.attendees.length,
      model: data.model || "",
      warnings: data.warnings ?? [],
    });
  };

  const run = async (job: () => Promise<void>) => {
    setError(null);
    setOutcome(null);
    try {
      await job();
    } catch (err) {
      if (!(err instanceof DocumentError)) {
        console.error("[import] failed", err);
      }
      setError(
        err instanceof DocumentError
          ? err.message
          : "整理失败，请检查网络后再试。"
      );
    } finally {
      setWorking(null);
    }
  };

  const handleFile = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // 清空后同一个文件可以再选一次
    event.target.value = "";
    if (!file) return;
    run(async () => {
      setWorking(`正在读取《${file.name}》……`);
      const text = await readDocumentFile(file);
      await convert(text, `《${file.name}》`, file.name);
    });
  };

  const handlePasted = () => {
    if (pasted.trim().length < 10) {
      setOutcome(null);
      setError("请先粘贴会议通知或议程的文字。");
      return;
    }
    run(() => convert(pasted, "粘贴的文字"));
  };

  return (
    <div className="space-y-2 rounded-lg border border-dashed border-blue-500/40 bg-blue-500/5 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Label className="text-base font-semibold flex items-center gap-1.5">
          <Sparkles className="w-4 h-4 text-blue-500" />
          从文档导入
        </Label>
        <div className="flex items-center gap-2">
          <input
            ref={fileRef}
            type="file"
            accept={DOCUMENT_ACCEPT}
            className="hidden"
            onChange={handleFile}
            aria-label="选择会议文档"
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 gap-1"
            disabled={!!working}
            onClick={() => fileRef.current?.click()}
          >
            <FileUp className="w-3.5 h-3.5" />
            选择文件
          </Button>
          <Button
            type="button"
            variant={pasting ? "secondary" : "outline"}
            size="sm"
            className="h-8 gap-1"
            disabled={!!working}
            onClick={() => setPasting(!pasting)}
          >
            <ClipboardPaste className="w-3.5 h-3.5" />
            粘贴文字
          </Button>
        </div>
      </div>
      <p className="text-[11px] text-muted-foreground leading-relaxed">
        支持 md、docx、txt 格式的会议通知或议程。AI
        读出会议名称、参会人和议题后填到下面，覆盖当前内容；核对无误再点「确认并保存」。
        文件在本机读取，只把文字发给公司 AI 网关整理。
      </p>

      {pasting && (
        <div className="space-y-2">
          <textarea
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
            placeholder="把会议通知或议程的文字粘贴到这里"
            rows={6}
            disabled={!!working}
            aria-label="会议文档文字"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-xs leading-relaxed focus:outline-none focus:ring-1 focus:ring-ring"
          />
          <div className="flex justify-end">
            <Button
              type="button"
              size="sm"
              className="h-8 gap-1"
              disabled={!!working}
              onClick={handlePasted}
            >
              <Sparkles className="w-3.5 h-3.5" />
              转换
            </Button>
          </div>
        </div>
      )}

      {working && (
        <div
          className="flex items-center gap-2 text-xs text-blue-600 dark:text-blue-400"
          role="status"
        >
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          {working}
        </div>
      )}

      {error && (
        <div
          className="text-xs text-destructive bg-destructive/10 p-2.5 rounded-md"
          role="alert"
        >
          {error}
        </div>
      )}

      {outcome && (
        <div className="space-y-1.5 text-xs" role="status">
          <div className="flex items-start gap-1.5 text-emerald-700 dark:text-emerald-400">
            <CheckCircle2 className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
            <span>
              已从{outcome.source}读出 {outcome.agendas} 个议题、
              {outcome.attendees} 位参会人
              {outcome.model ? `（由 ${outcome.model} 整理）` : ""}
              。请核对下面的内容。
            </span>
          </div>
          {outcome.warnings.map((w) => (
            <div
              key={w}
              className="flex items-start gap-1.5 text-amber-700 dark:text-amber-400"
            >
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
              <span>{w}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
