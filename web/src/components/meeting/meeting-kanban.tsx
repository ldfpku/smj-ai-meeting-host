"use client";

import React, { useState, useEffect } from "react";
import {
  MeetingConfig,
  MeetingLiveState,
  DecisionItem,
  playAttentionChime,
} from "@/data/meeting";
import {
  Clock,
  CheckCircle2,
  CircleDot,
  AlertTriangle,
  FileText,
  Copy,
  ChevronRight,
  Settings,
  Target,
  UserCheck,
  Calendar,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { useRoomContext } from "@livekit/components-react";

interface MeetingKanbanProps {
  config: MeetingConfig;
  liveState: MeetingLiveState;
  onAdvanceAgenda?: (nextIndex: number) => void;
  onOpenConfigModal?: () => void;
  isConnectingOrConnected: boolean;
}

export function MeetingKanban({
  config,
  liveState,
  onAdvanceAgenda,
  onOpenConfigModal,
  isConnectingOrConnected,
}: MeetingKanbanProps) {
  const { toast } = useToast();
  const room = useRoomContext();

  // Local seconds counter for smooth visual countdown
  const [localSeconds, setLocalSeconds] = useState(liveState.elapsedSeconds || 0);

  useEffect(() => {
    setLocalSeconds(liveState.elapsedSeconds);
  }, [liveState.elapsedSeconds]);

  useEffect(() => {
    if (!isConnectingOrConnected || liveState.isFinished) return;
    const timer = setInterval(() => {
      setLocalSeconds((prev) => prev + 1);
    }, 1000);
    return () => clearInterval(timer);
  }, [isConnectingOrConnected, liveState.isFinished]);

  const totalAllowedSeconds = config.totalDurationMinutes * 60;
  const progressPercent = Math.min(
    100,
    Math.round((localSeconds / (totalAllowedSeconds || 1)) * 100)
  );
  const isOverdue = localSeconds > totalAllowedSeconds;

  const formatTime = (secs: number) => {
    const mins = Math.floor(secs / 60);
    const s = secs % 60;
    return `${mins.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  };

  const currentAgenda = config.agendas[liveState.currentAgendaIndex] || config.agendas[0];

  const handleManualAdvance = async () => {
    const nextIdx = liveState.currentAgendaIndex + 1;
    if (nextIdx < config.agendas.length) {
      if (onAdvanceAgenda) {
        onAdvanceAgenda(nextIdx);
      }
      // Also notify agent via room RPC if available
      try {
        if (room?.localParticipant) {
          await room.localParticipant.performRpc({
            destinationIdentity: "", // broadcast
            method: "pg.advanceAgenda",
            payload: JSON.stringify({ item_index: nextIdx + 1 }),
          });
        }
      } catch (err) {
        console.log("Manual advance RPC dispatched locally", err);
      }
      toast({
        title: `已推进到议题 ${nextIdx + 1}`,
        description: `当前议题：${config.agendas[nextIdx].title}`,
      });
    } else {
      toast({
        title: "已是最后一项议题",
        description: "会议所有议程已完成讨论。",
      });
    }
  };

  const handleForceIntervene = async () => {
    playAttentionChime();
    try {
      if (room?.localParticipant) {
        await room.localParticipant.performRpc({
          destinationIdentity: "",
          method: "pg.forceIntervene",
          payload: JSON.stringify({ reason: "参会人手动呼叫主持人介入纠偏" }),
        });
      }
      toast({
        title: "已呼叫主持人即刻介入",
        description: "AI 主持人将强行打断发言并收拢全场讨论。",
      });
    } catch (err) {
      console.log("Manual intervene RPC dispatched", err);
    }
  };

  const handleCopySummary = () => {
    const lines: string[] = [
      `# 📝 会议纪要：${config.topic}`,
      `**会议总用时**：${Math.round(localSeconds / 60)} 分钟 (计划: ${config.totalDurationMinutes} 分钟)`,
      `**日期**：${new Date().toLocaleDateString()}`,
      "",
      `## 议程完成情况`,
    ];

    config.agendas.forEach((item, idx) => {
      const isDone = idx < liveState.currentAgendaIndex;
      const isCur = idx === liveState.currentAgendaIndex;
      const statusStr = isDone ? "✅ 已完成" : isCur ? "⏳ 进行中" : "⚪ 待开始";
      lines.push(`- ${statusStr} 议题 ${idx + 1}: **${item.title}** (${item.durationMinutes}分钟) - 目标: ${item.goal}`);
    });

    lines.push("", `## 📌 达成决议与 Action Items (${liveState.decisions.length})`);
    if (liveState.decisions.length === 0) {
      lines.push("*(未记录明确决议)*");
    } else {
      liveState.decisions.forEach((d, idx) => {
        lines.push(
          `${idx + 1}. **【${d.agendaTitle}】** ${d.decision}`,
          `   - **负责人**：${d.owner || "未指定"}`,
          `   - **交付期**：${d.dueDate || "未指定"}`
        );
      });
    }

    navigator.clipboard.writeText(lines.join("\n"));
    toast({
      title: "会议纪要已复制到剪贴板",
      description: "已生成包含议程状态与决议待办的完整 Markdown 格式文档。",
    });
  };

  return (
    <div className="flex flex-col h-full w-full bg-card/60 backdrop-blur-md rounded-xl border border-border/80 p-4 space-y-4 shadow-sm overflow-hidden">
      {/* 头部：主题与控制 */}
      <div className="flex items-center justify-between pb-3 border-b border-border/60">
        <div className="min-w-0 pr-2">
          <div className="flex items-center gap-2">
            <span className="font-bold text-base truncate">{config.topic}</span>
            <Badge variant="outline" className="text-xs px-2 py-0">
              {config.style === "strict"
                ? "果断控场"
                : config.style === "gentle"
                ? "温和引导"
                : "极简报时"}
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">
            共 {config.agendas.length} 项议题 · 计划 {config.totalDurationMinutes} 分钟
          </p>
        </div>

        <div className="flex items-center gap-1.5 flex-shrink-0">
          {onOpenConfigModal && !isConnectingOrConnected && (
            <Button
              variant="ghost"
              size="icon"
              onClick={onOpenConfigModal}
              className="h-8 w-8 text-muted-foreground hover:text-foreground"
              title="修改议程"
            >
              <Settings className="w-4 h-4" />
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={handleCopySummary}
            className="h-8 gap-1 text-xs"
          >
            <Copy className="w-3.5 h-3.5" />
            复制纪要
          </Button>
        </div>
      </div>

      {/* 时间仪表盘 */}
      <div className="space-y-2 bg-muted/30 p-3 rounded-lg border border-border/40">
        <div className="flex items-center justify-between text-xs">
          <div className="flex items-center gap-1.5 text-muted-foreground">
            <Clock className="w-3.5 h-3.5" />
            <span>已用时: <strong className="text-foreground">{formatTime(localSeconds)}</strong></span>
          </div>
          <div className="flex items-center gap-2">
            {isOverdue ? (
              <Badge variant="destructive" className="text-[10px] px-1.5 py-0 flex items-center gap-1">
                <AlertTriangle className="w-3 h-3" /> 超时 {formatTime(localSeconds - totalAllowedSeconds)}
              </Badge>
            ) : (
              <span className="text-muted-foreground">
                剩余: <strong className="text-foreground">{formatTime(totalAllowedSeconds - localSeconds)}</strong>
              </span>
            )}
          </div>
        </div>
        <Progress
          value={progressPercent}
          className={`h-2 ${isOverdue ? "[&>div]:bg-red-500" : progressPercent > 80 ? "[&>div]:bg-amber-500" : ""}`}
        />
      </div>

      {/* 当前议题高亮卡片 */}
      <div className="p-3 rounded-lg border border-blue-500/30 bg-blue-500/5 space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5 text-xs text-blue-500 font-semibold uppercase tracking-wider">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500"></span>
            </span>
            当前议题 ({liveState.currentAgendaIndex + 1}/{config.agendas.length})
          </div>
          <div className="flex items-center gap-1.5">
            <Button
              size="sm"
              variant="outline"
              onClick={handleForceIntervene}
              className="h-6 px-2 text-xs text-amber-600 dark:text-amber-400 border-amber-500/40 hover:bg-amber-500/10 gap-1 font-medium"
              title="当讨论跑题或长篇大论时，立即呼叫AI主持人强势打断介入"
            >
              <Zap className="w-3 h-3 text-amber-500 fill-amber-500" />
              立即纠偏
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={handleManualAdvance}
              disabled={liveState.currentAgendaIndex >= config.agendas.length - 1}
              className="h-6 px-2 text-xs text-blue-500 hover:text-blue-600 hover:bg-blue-500/10 gap-1"
            >
              推进议题 <ChevronRight className="w-3 h-3" />
            </Button>
          </div>
        </div>

        <div className="text-sm font-semibold">{currentAgenda?.title}</div>
        {currentAgenda?.goal && (
          <div className="flex items-start gap-1.5 text-xs text-muted-foreground">
            <Target className="w-3.5 h-3.5 mt-0.5 text-blue-400 flex-shrink-0" />
            <span>{currentAgenda.goal}</span>
          </div>
        )}
      </div>

      {/* 议程时间轴列表 */}
      <div className="space-y-1.5 flex-1 min-h-0 overflow-y-auto pr-1">
        <div className="text-xs font-semibold text-muted-foreground mb-1">
          完整议程流转
        </div>
        {config.agendas.map((item, idx) => {
          const isDone = idx < liveState.currentAgendaIndex;
          const isCurrent = idx === liveState.currentAgendaIndex;
          return (
            <div
              key={item.id}
              className={`flex items-center justify-between p-2 rounded-md text-xs transition-colors ${
                isCurrent
                  ? "bg-muted/80 font-medium border border-border"
                  : isDone
                  ? "text-muted-foreground line-through opacity-70"
                  : "text-muted-foreground hover:bg-muted/30"
              }`}
            >
              <div className="flex items-center gap-2 truncate">
                {isDone ? (
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 flex-shrink-0" />
                ) : isCurrent ? (
                  <CircleDot className="w-3.5 h-3.5 text-blue-500 flex-shrink-0" />
                ) : (
                  <div className="w-3.5 h-3.5 rounded-full border border-muted-foreground/40 flex-shrink-0" />
                )}
                <span className="truncate">{item.title}</span>
              </div>
              <span className="text-[11px] text-muted-foreground ml-2 flex-shrink-0">
                {item.durationMinutes}m
              </span>
            </div>
          );
        })}
      </div>

      {/* 实时固化决议与 Action Items */}
      <div className="border-t border-border/60 pt-3 space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5 text-xs font-semibold">
            <FileText className="w-3.5 h-3.5 text-emerald-500" />
            <span>已敲定决议与待办 ({liveState.decisions.length})</span>
          </div>
        </div>

        <div className="max-h-36 overflow-y-auto space-y-1.5 pr-1">
          {liveState.decisions.length === 0 ? (
            <div className="text-center py-4 text-xs text-muted-foreground/60 border border-dashed rounded-lg">
              讨论形成结论后，AI 主持人将自动记录上墙...
            </div>
          ) : (
            liveState.decisions.map((dec) => (
              <div
                key={dec.id}
                className="p-2 rounded bg-emerald-500/5 border border-emerald-500/20 text-xs space-y-1"
              >
                <div className="font-semibold text-foreground flex items-center justify-between">
                  <span className="text-emerald-600 dark:text-emerald-400">
                    [{dec.agendaTitle || "决议"}]
                  </span>
                  <span className="text-[10px] text-muted-foreground">
                    {new Date(dec.timestamp).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                </div>
                <div className="text-foreground/90">{dec.decision}</div>
                {(dec.owner || dec.dueDate) && (
                  <div className="flex items-center gap-3 text-[11px] text-muted-foreground pt-0.5">
                    {dec.owner && (
                      <span className="flex items-center gap-1">
                        <UserCheck className="w-3 h-3 text-emerald-500" />
                        {dec.owner}
                      </span>
                    )}
                    {dec.dueDate && (
                      <span className="flex items-center gap-1">
                        <Calendar className="w-3 h-3 text-emerald-500" />
                        {dec.dueDate}
                      </span>
                    )}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
