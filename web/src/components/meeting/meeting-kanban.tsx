"use client";

import React, { useState, useEffect } from "react";
import {
  InterventionMode,
  MeetingConfig,
  MeetingLiveState,
  defaultInterventionSettings,
  playAttentionChime,
  missingDecisionFields,
} from "@/data/meeting";
import {
  generateMinutesMarkdown,
  minutesFileName,
} from "@/data/meeting-minutes";
import {
  MinutesDialog,
  MinutesSource,
} from "@/components/meeting/minutes-dialog";
import SegmentedControl from "@/components/ui/segmented-control";
import { usePlaygroundState } from "@/hooks/use-playground-state";
import {
  Clock,
  CheckCircle2,
  CircleDot,
  AlertTriangle,
  FileText,
  Copy,
  Download,
  ChevronRight,
  Settings,
  Target,
  UserCheck,
  Calendar,
  Zap,
  ShieldCheck,
  Paperclip,
  Megaphone,
  HelpCircle,
  ArrowUpCircle,
  Sparkles,
  Radar,
  Square,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { useRoomContext } from "@livekit/components-react";
import { useAgent } from "@/hooks/use-agent";
import { useConnection } from "@/hooks/use-connection";

interface MeetingKanbanProps {
  config: MeetingConfig;
  liveState: MeetingLiveState;
  onAdvanceAgenda?: (nextIndex: number) => void;
  onToggleSpoken?: (attendeeId: string) => void;
  onOpenConfigModal?: () => void;
  isConnectingOrConnected: boolean;
}

export function MeetingKanban({
  config,
  liveState,
  onAdvanceAgenda,
  onToggleSpoken,
  onOpenConfigModal,
  isConnectingOrConnected,
}: MeetingKanbanProps) {
  const { toast } = useToast();
  const room = useRoomContext();
  const { agent, transcript } = useAgent();
  const { dispatch } = usePlaygroundState();
  const { disconnect } = useConnection();
  const [showMinutesDialog, setShowMinutesDialog] = useState(false);
  // 「结束会议」要点两次：第一次只是进入待确认状态，几秒后自动复原
  const [confirmingEnd, setConfirmingEnd] = useState(false);

  useEffect(() => {
    if (!confirmingEnd) return;
    const timer = setTimeout(() => setConfirmingEnd(false), 4000);
    return () => clearTimeout(timer);
  }, [confirmingEnd]);

  useEffect(() => {
    if (!isConnectingOrConnected) setConfirmingEnd(false);
  }, [isConnectingOrConnected]);

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

  const currentAgenda =
    config.agendas[liveState.currentAgendaIndex] || config.agendas[0];

  const requiredAttendees = config.attendees.filter(
    (a) => a.required && (a.name.trim() || a.role.trim())
  );
  const pendingSpeakers = requiredAttendees.filter(
    (a) => !liveState.spokenAttendeeIds.includes(a.id)
  );
  const incompleteDecisions = liveState.decisions.filter(
    (d) => missingDecisionFields(d).length > 0
  );

  /**
   * performRpc 必须指定具体的目标身份。此前这里传的是空字符串并注释为
   * "broadcast"，LiveKit 会直接抛错，而 catch 只做 console.log——
   * 于是看板本地推进了，agent 端却毫不知情。
   */
  const callAgent = async (
    method: string,
    payload: Record<string, unknown>
  ): Promise<boolean> => {
    if (!room?.localParticipant || !agent?.identity) {
      toast({
        title: "主持人尚未就位",
        description: "AI 主持人还没有连接到会议，请稍候重试。",
        variant: "destructive",
      });
      return false;
    }
    try {
      await room.localParticipant.performRpc({
        destinationIdentity: agent.identity,
        method,
        payload: JSON.stringify(payload),
      });
      return true;
    } catch (err) {
      console.error(`${method} RPC failed`, err);
      toast({
        title: "指令未送达主持人",
        description: "AI 主持人未响应本次操作，请重试。",
        variant: "destructive",
      });
      return false;
    }
  };

  const handleManualAdvance = async () => {
    const nextIdx = liveState.currentAgendaIndex + 1;
    if (nextIdx >= config.agendas.length) {
      toast({
        title: "已是最后一项议题",
        description: "会议所有议程已完成讨论。",
      });
      return;
    }
    const ok = await callAgent("pg.advanceAgenda", { item_index: nextIdx + 1 });
    if (!ok) return;
    onAdvanceAgenda?.(nextIdx);
    toast({
      title: `已推进到议题 ${nextIdx + 1}`,
      description: `当前议题：${config.agendas[nextIdx].title}`,
    });
  };

  const handleEndMeeting = async () => {
    if (!confirmingEnd) {
      setConfirmingEnd(true);
      return;
    }
    setConfirmingEnd(false);
    // 让 agent 关闭房间并停止各项模型调用。它没有回应时也要断开：
    // 浏览器离开后 agent 会在 20 秒内自行结束。
    if (room?.localParticipant && agent?.identity) {
      try {
        await room.localParticipant.performRpc({
          destinationIdentity: agent.identity,
          method: "pg.endMeeting",
          payload: "{}",
        });
        // 「会议已结束」的提示随 agent 的 meeting_ended 消息给出
        return;
      } catch (err) {
        console.error("pg.endMeeting RPC failed", err);
      }
    }
    await disconnect();
    toast({
      title: "会议已结束",
      description: "连接已断开。转写和决议已保存在本机，可继续生成纪要。",
    });
  };

  const handleForceIntervene = async () => {
    playAttentionChime();
    const ok = await callAgent("pg.forceIntervene", {
      reason: "参会人手动呼叫主持人介入纠偏",
    });
    if (ok) {
      toast({
        title: "已呼叫主持人即刻介入",
        description: "AI 主持人会打断发言，把讨论拉回当前议题。",
      });
    }
  };

  // ---- 跑题介入：模式切换与实时置信度 -------------------------------------

  // 会中以 agent 实际生效的设置为准，会前以会议配置为准
  const intervention = isConnectingOrConnected
    ? liveState.intervention
    : { ...defaultInterventionSettings, ...config.intervention };

  const handleModeChange = async (mode: string) => {
    if (mode !== "auto" && mode !== "semi_auto") return;
    if (mode === intervention.mode) return;
    const next = { ...intervention, mode: mode as InterventionMode };

    if (isConnectingOrConnected) {
      const ok = await callAgent("pg.updateIntervention", { mode });
      if (!ok) return;
    }
    // 同步回会议配置：下次开会沿用，且配置表单不会把它当成一次新的改动
    dispatch({
      type: "SET_SESSION_CONFIG",
      payload: { meetingConfig: { ...config, intervention: next } },
    });
    toast({
      title: mode === "auto" ? "已切换为自动打断" : "已切换为半自动",
      description:
        mode === "auto"
          ? "检测到跑题时，AI 主持人会直接打断。"
          : "检测到跑题时只在看板上提示，由你决定是否打断。",
    });
  };

  const score = liveState.driftScore;
  // 超过 15 秒没有新判断，说明没人在说话，读数已经过期
  const scoreIsFresh = !!score && Date.now() - score.at < 15_000;

  const buildMinutes = () =>
    generateMinutesMarkdown({
      config,
      liveState,
      elapsedSeconds: localSeconds,
    });

  const getMinutesSource = (): MinutesSource => ({
    config,
    liveState,
    elapsedSeconds: localSeconds,
    transcript: transcript.map((t) => ({ role: t.role, text: t.text, at: t.at })),
    startedAt: liveState.startTime,
  });

  const handleCopyMinutes = () => {
    navigator.clipboard.writeText(buildMinutes());
    toast({
      title: "会议纪要已复制到剪贴板",
      description: "含决议四要素、未决事项与回执确认栏。",
    });
  };

  const handleDownloadMinutes = () => {
    const blob = new Blob([buildMinutes()], {
      type: "text/markdown;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = minutesFileName(config);
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast({
      title: "会议纪要已导出",
      description: "可直接发给参会人做回执确认。",
    });
  };

  return (
    <div className="flex flex-col h-full w-full bg-card/60 backdrop-blur-md rounded-xl border border-border/80 p-4 space-y-3 shadow-sm overflow-hidden">
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
          <p className="text-xs text-muted-foreground mt-0.5 truncate">
            {config.meetingType ? `${config.meetingType} · ` : ""}
            {config.chair ? `${config.chair}主持 · ` : ""}
            {config.agendas.length} 项议题 · 计划 {config.totalDurationMinutes} 分钟
          </p>
        </div>

        <div className="flex items-center gap-1.5 flex-shrink-0">
          {onOpenConfigModal && !isConnectingOrConnected && (
            <Button
              variant="ghost"
              size="icon"
              onClick={onOpenConfigModal}
              className="h-8 w-8 text-muted-foreground hover:text-foreground"
              title="选择会议模板 / 修改议程与参会人"
            >
              <Settings className="w-4 h-4" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            onClick={handleCopyMinutes}
            className="h-8 w-8 text-muted-foreground hover:text-foreground"
            title="复制纪要到剪贴板"
          >
            <Copy className="w-3.5 h-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={handleDownloadMinutes}
            className="h-8 w-8 text-muted-foreground hover:text-foreground"
            title="导出模板纪要（Markdown 文件，不含 AI 整理内容）"
          >
            <Download className="w-3.5 h-3.5" />
          </Button>
          <Button
            size="sm"
            onClick={() => setShowMinutesDialog(true)}
            className="h-8 gap-1 text-xs"
            title="由 AI 根据会议转写整理讨论要点，生成可编辑的纪要草稿"
          >
            <Sparkles className="w-3.5 h-3.5" />
            AI 纪要
          </Button>
          {isConnectingOrConnected && (
            <Button
              size="sm"
              variant="destructive"
              onClick={handleEndMeeting}
              className="h-8 gap-1 text-xs"
              title="结束会议：断开连接并关闭房间，之后不再产生模型和通话费用"
            >
              <Square className="w-3 h-3 fill-current" />
              {confirmingEnd ? "再点一次确认" : "结束会议"}
            </Button>
          )}
        </div>
      </div>

      <MinutesDialog
        open={showMinutesDialog}
        onOpenChange={setShowMinutesDialog}
        getSource={getMinutesSource}
      />

      {/* 时间仪表盘 */}
      <div className="space-y-2 bg-muted/30 p-3 rounded-lg border border-border/40">
        <div className="flex items-center justify-between text-xs">
          <div className="flex items-center gap-1.5 text-muted-foreground">
            <Clock className="w-3.5 h-3.5" />
            <span>
              已用时: <strong className="text-foreground">{formatTime(localSeconds)}</strong>
            </span>
          </div>
          <div className="flex items-center gap-2">
            {isOverdue ? (
              <Badge
                variant="destructive"
                className="text-[10px] px-1.5 py-0 flex items-center gap-1"
              >
                <AlertTriangle className="w-3 h-3" /> 超时{" "}
                {formatTime(localSeconds - totalAllowedSeconds)}
              </Badge>
            ) : (
              <span className="text-muted-foreground">
                剩余:{" "}
                <strong className="text-foreground">
                  {formatTime(totalAllowedSeconds - localSeconds)}
                </strong>
              </span>
            )}
          </div>
        </div>
        <Progress
          value={progressPercent}
          className={`h-2 ${
            isOverdue
              ? "[&>div]:bg-red-500"
              : progressPercent > 80
              ? "[&>div]:bg-amber-500"
              : ""
          }`}
        />
      </div>

      {/* 跑题介入：模式与实时偏题概率 */}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-3 py-2 rounded-lg border border-border/40 bg-muted/20">
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground whitespace-nowrap">
            跑题介入
          </span>
          <SegmentedControl
            value={intervention.mode}
            onValueChange={handleModeChange}
            options={[
              { value: "auto", label: "自动打断" },
              { value: "semi_auto", label: "半自动" },
            ]}
            className="w-[168px]"
          />
        </div>

        <div
          className="flex items-center gap-2 text-[11px] text-muted-foreground"
          title={
            liveState.detectorActive
              ? `Jev 每隔约 1 秒判断一次最近的发言。偏题概率达到 ${Math.round(
                  intervention.threshold * 100
                )}% 即${intervention.mode === "auto" ? "打断" : "提示"}。`
              : "agent 未配置 JEV_API_KEY：跑题只靠 AI 主持人自行判断，没有置信度读数。"
          }
        >
          <Radar className="w-3.5 h-3.5 flex-shrink-0" />
          {!isConnectingOrConnected ? (
            <span>
              阈值 {Math.round(intervention.threshold * 100)}% · 冷却{" "}
              {intervention.cooldownSeconds} 秒
            </span>
          ) : !liveState.detectorActive ? (
            <span>未启用 Jev 检测</span>
          ) : (
            <>
              <span className="whitespace-nowrap">偏题概率</span>
              <span className="relative w-24 h-1.5 rounded-full bg-muted overflow-hidden">
                <span
                  className={`block h-full rounded-full transition-all duration-300 ${
                    scoreIsFresh && score!.confidence >= intervention.threshold
                      ? "bg-amber-500"
                      : "bg-emerald-500"
                  }`}
                  style={{
                    width: `${scoreIsFresh ? Math.round(score!.confidence * 100) : 0}%`,
                  }}
                />
                <span
                  className="absolute top-0 h-full w-px bg-foreground/50"
                  style={{ left: `${Math.round(intervention.threshold * 100)}%` }}
                />
              </span>
              <span className="tabular-nums w-8 text-right">
                {scoreIsFresh ? `${Math.round(score!.confidence * 100)}%` : "—"}
              </span>
            </>
          )}
        </div>
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
              disabled={
                liveState.currentAgendaIndex >= config.agendas.length - 1
              }
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
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
          {currentAgenda?.processId && (
            <span className="flex items-center gap-1">
              <ShieldCheck className="w-3 h-3 text-blue-400" />
              流程 {currentAgenda.processId}
            </span>
          )}
          {currentAgenda?.preReadRef && (
            <span className="flex items-center gap-1 min-w-0">
              <Paperclip className="w-3 h-3 text-blue-400 flex-shrink-0" />
              <span className="truncate">前置：{currentAgenda.preReadRef}</span>
            </span>
          )}
        </div>
      </div>

      {/* 点名发言：沉默不等于同意 */}
      {requiredAttendees.length > 0 && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-xs font-semibold">
            <div className="flex items-center gap-1.5">
              <Megaphone className="w-3.5 h-3.5 text-violet-500" />
              <span>
                本议题表态 ({requiredAttendees.length - pendingSpeakers.length}/
                {requiredAttendees.length})
              </span>
            </div>
            {pendingSpeakers.length > 0 && (
              <span className="text-[10px] font-normal text-violet-600 dark:text-violet-400">
                沉默不等于同意
              </span>
            )}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {requiredAttendees.map((a) => {
              const spoken = liveState.spokenAttendeeIds.includes(a.id);
              const called = liveState.calledAttendeeIds.includes(a.id);
              const label = a.name.trim() || a.role.trim();
              return (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => onToggleSpoken?.(a.id)}
                  title={
                    spoken
                      ? "已表态（点击撤销）"
                      : called
                      ? "主持人已点名，等待表态（点击标记为已表态）"
                      : "尚未表态（点击标记为已表态）"
                  }
                  className={`px-2 py-0.5 rounded-full text-[11px] border transition-colors ${
                    spoken
                      ? "bg-emerald-500/10 border-emerald-500/40 text-emerald-600 dark:text-emerald-400"
                      : called
                      ? "bg-violet-500/10 border-violet-500/50 text-violet-600 dark:text-violet-400 animate-pulse"
                      : "bg-muted/40 border-border text-muted-foreground hover:bg-muted"
                  }`}
                >
                  {spoken ? "✓ " : called ? "◉ " : ""}
                  {label}
                </button>
              );
            })}
          </div>
        </div>
      )}

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

      {/* 未决事项与升级 */}
      {liveState.openItems.length > 0 && (
        <div className="border-t border-border/60 pt-2.5 space-y-1.5">
          <div className="flex items-center gap-1.5 text-xs font-semibold">
            <HelpCircle className="w-3.5 h-3.5 text-orange-500" />
            <span>未决事项 ({liveState.openItems.length})</span>
          </div>
          <div className="max-h-28 overflow-y-auto space-y-1.5 pr-1">
            {liveState.openItems.map((o) => (
              <div
                key={o.id}
                className="p-2 rounded bg-orange-500/5 border border-orange-500/25 text-xs space-y-1"
              >
                <div className="text-foreground/90 font-medium">{o.issue}</div>
                {o.reason && (
                  <div className="text-[11px] text-muted-foreground">
                    未决原因：{o.reason}
                  </div>
                )}
                <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
                  {o.owner && (
                    <span className="flex items-center gap-1">
                      <UserCheck className="w-3 h-3 text-orange-500" />
                      {o.owner}
                    </span>
                  )}
                  <span className="flex items-center gap-1">
                    <ArrowUpCircle className="w-3 h-3 text-orange-500" />
                    升级：{o.escalateTo}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 实时固化决议与 Action Items */}
      <div className="border-t border-border/60 pt-2.5 space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5 text-xs font-semibold">
            <FileText className="w-3.5 h-3.5 text-emerald-500" />
            <span>已敲定决议 ({liveState.decisions.length})</span>
          </div>
          {incompleteDecisions.length > 0 && (
            <span className="text-[10px] text-red-500 font-medium">
              {incompleteDecisions.length} 条要素不全
            </span>
          )}
        </div>

        <div className="max-h-36 overflow-y-auto space-y-1.5 pr-1">
          {liveState.decisions.length === 0 ? (
            <div className="text-center py-4 text-xs text-muted-foreground/60 border border-dashed rounded-lg">
              讨论形成结论后，AI 主持人将自动记录上墙...
            </div>
          ) : (
            liveState.decisions.map((dec) => {
              const missing = missingDecisionFields(dec);
              return (
                <div
                  key={dec.id}
                  className={`p-2 rounded text-xs space-y-1 border ${
                    missing.length
                      ? "bg-red-500/5 border-red-500/25"
                      : "bg-emerald-500/5 border-emerald-500/20"
                  }`}
                >
                  <div className="font-semibold text-foreground flex items-center justify-between gap-2">
                    <span
                      className={
                        missing.length
                          ? "text-red-600 dark:text-red-400 truncate"
                          : "text-emerald-600 dark:text-emerald-400 truncate"
                      }
                    >
                      [{dec.agendaTitle || "决议"}]
                      {dec.processId ? ` ${dec.processId}` : ""}
                    </span>
                    <span className="text-[10px] text-muted-foreground flex-shrink-0">
                      {new Date(dec.timestamp).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                  </div>
                  <div className="text-foreground/90">{dec.decision}</div>

                  <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground pt-0.5">
                    <span className="flex items-center gap-1">
                      <UserCheck className="w-3 h-3 text-emerald-500" />
                      {dec.owner || "—"}
                      {dec.ownerDept ? `（${dec.ownerDept}）` : ""}
                    </span>
                    <span className="flex items-center gap-1">
                      <Calendar className="w-3 h-3 text-emerald-500" />
                      {dec.dueDate || "—"}
                    </span>
                  </div>
                  {(dec.verification || dec.evidence) && (
                    <div className="text-[11px] text-muted-foreground space-y-0.5">
                      {dec.verification && <div>验证方式：{dec.verification}</div>}
                      {dec.evidence && <div>关闭证据：{dec.evidence}</div>}
                    </div>
                  )}
                  {missing.length > 0 && (
                    <div className="text-[11px] text-red-500 font-medium">
                      待补：{missing.join("、")}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
