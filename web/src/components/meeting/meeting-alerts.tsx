"use client";

import React, { useEffect, useRef, useState } from "react";
import { useVoiceAssistant } from "@livekit/components-react";
import { AlertTriangle, Clock, History, Undo2, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAgent } from "@/hooks/use-agent";
import { useAgentRpc } from "@/hooks/use-agent-rpc";
import { useToast } from "@/hooks/use-toast";
import { driftSourceLabels, playAttentionChime } from "@/data/meeting";

/** 跑题提示在屏幕上停留多久 */
const DRIFT_ALERT_TTL_MS = 20_000;
const OVERTIME_ALERT_TTL_MS = 30_000;
/** 撤销后本地静音的最长时间：服务端会把这一轮说完，但没人需要听 */
const UNDO_MUTE_MAX_MS = 8_000;

function ConfidenceBar({ value }: { value: number }) {
  const percent = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <span
      className="inline-flex items-center gap-1.5 flex-shrink-0"
      title="偏题概率：Jev 判断这段讨论偏离当前议题的把握"
    >
      <span className="w-16 h-1.5 rounded-full bg-amber-500/20 overflow-hidden">
        <span
          className="block h-full bg-amber-500 rounded-full"
          style={{ width: `${percent}%` }}
        />
      </span>
      <span className="tabular-nums">{percent}%</span>
    </span>
  );
}

function seconds(ms: number | null | undefined): string | null {
  return typeof ms === "number" ? `${(ms / 1000).toFixed(1)} 秒` : null;
}

interface MeetingAlertsProps {
  onOpenPreviousSession: () => void;
}

/** 会议区上方的提示条：跑题打断、半自动建议、议题超时、上一场会议记录。 */
export function MeetingAlerts({ onOpenPreviousSession }: MeetingAlertsProps) {
  const {
    meetingLiveState,
    updateMeetingLiveState,
    previousSession,
    dismissPreviousSession,
  } = useAgent();
  const { agent, audioTrack, state: agentState } = useVoiceAssistant();
  const callAgent = useAgentRpc();
  const { toast } = useToast();
  const { driftAlert, driftSuggestion, overtimeAlert } = meetingLiveState;

  const [, forceTick] = useState(0);
  const mutedUntilRef = useRef(0);

  // 主持人有两条音轨：实时模型的声音，和直接播放的打断语音。两条都要管到。
  const setAgentVolume = (volume: number) => {
    const publications = agent
      ? Array.from(agent.audioTrackPublications.values())
      : audioTrack?.publication
      ? [audioTrack.publication]
      : [];
    for (const publication of publications) {
      const track = publication.track as
        | { setVolume?: (v: number) => void }
        | undefined;
      track?.setVolume?.(volume);
    }
  };

  // 提示条到期自动消失
  useEffect(() => {
    const deadlines = [
      driftAlert ? driftAlert.at + DRIFT_ALERT_TTL_MS : 0,
      driftSuggestion ? driftSuggestion.expiresAt : 0,
      overtimeAlert ? overtimeAlert.at + OVERTIME_ALERT_TTL_MS : 0,
    ].filter(Boolean);
    if (deadlines.length === 0) return;

    const timer = setInterval(() => {
      const now = Date.now();
      const expired: Parameters<typeof updateMeetingLiveState>[0] = {};
      if (driftAlert && now > driftAlert.at + DRIFT_ALERT_TTL_MS) {
        expired.driftAlert = null;
      }
      if (driftSuggestion && now > driftSuggestion.expiresAt) {
        expired.driftSuggestion = null;
      }
      if (overtimeAlert && now > overtimeAlert.at + OVERTIME_ALERT_TTL_MS) {
        expired.overtimeAlert = null;
      }
      if (Object.keys(expired).length) updateMeetingLiveState(expired);
      forceTick((n) => n + 1);
    }, 1000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [driftAlert, driftSuggestion, overtimeAlert]);

  // 撤销后的本地静音：主持人说完这一轮（或超时）就恢复
  useEffect(() => {
    if (!mutedUntilRef.current) return;
    const restore = () => {
      mutedUntilRef.current = 0;
      setAgentVolume(1);
    };
    if (agentState !== "speaking") {
      restore();
      return;
    }
    const timer = setTimeout(
      restore,
      Math.max(0, mutedUntilRef.current - Date.now())
    );
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentState, audioTrack]);

  const handleUndo = async () => {
    if (!driftAlert) return;
    // 先在本机静音，再通知 agent：不等网络往返
    mutedUntilRef.current = Date.now() + UNDO_MUTE_MAX_MS;
    setAgentVolume(0);
    // 打断语音不经过实时模型，主持人的状态不会变化，不能只靠状态变化来恢复音量
    setTimeout(() => {
      if (mutedUntilRef.current && Date.now() >= mutedUntilRef.current) {
        mutedUntilRef.current = 0;
        setAgentVolume(1);
      }
    }, UNDO_MUTE_MAX_MS + 50);
    const alert = driftAlert;
    updateMeetingLiveState({ driftAlert: null });

    const result = await callAgent("pg.undoIntervene", {
      interventionId: alert.interventionId,
    });
    if (result?.success) {
      toast({
        title: "已撤销本次打断",
        description: "已记为一次误判；主持人会在一段时间内不再自动打断。",
      });
    } else if (result) {
      toast({
        title: "这次打断已经结束",
        description: result.error || "没有可撤销的打断。",
      });
    }
  };

  const handleConfirmSuggestion = async () => {
    if (!driftSuggestion) return;
    const suggestion = driftSuggestion;
    updateMeetingLiveState({ driftSuggestion: null });
    await callAgent("pg.forceIntervene", {
      suggestionId: suggestion.suggestionId,
      reason: suggestion.reason,
    });
  };

  const handleDismissSuggestion = async () => {
    if (!driftSuggestion) return;
    updateMeetingLiveState({ driftSuggestion: null });
    await callAgent("pg.undoIntervene", { dismissed: true });
  };

  const handleForceIntervene = async () => {
    playAttentionChime();
    const result = await callAgent("pg.forceIntervene", {
      reason: "参会人手动呼叫主持人介入纠偏",
    });
    if (result?.success) {
      toast({
        title: "已呼叫主持人即刻介入",
        description: "AI 主持人将打断发言并收拢全场讨论。",
      });
    }
  };

  const showPrevious =
    !!previousSession &&
    !driftAlert &&
    !driftSuggestion &&
    agentState === "disconnected";

  return (
    <>
      {driftAlert && (
        <div
          role="alert"
          className="w-full py-2 px-3 sm:px-4 bg-amber-500/15 border border-amber-500/40 rounded-lg flex flex-wrap items-center justify-between gap-2 text-amber-700 dark:text-amber-400 text-xs shadow-sm"
        >
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 min-w-0">
            <span className="flex items-center gap-1.5 font-semibold">
              <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
              跑题预警：{driftAlert.reason || "讨论疑似偏离当前议题"}
            </span>
            <span className="text-[11px] opacity-80">
              {driftSourceLabels[driftAlert.source] ?? driftAlert.source}
            </span>
            {typeof driftAlert.confidence === "number" && (
              <span className="text-[11px]">
                <ConfidenceBar value={driftAlert.confidence} />
              </span>
            )}
            {seconds(driftAlert.speechStartMs ?? driftAlert.latencyMs) && (
              <span
                className="text-[11px] opacity-80 tabular-nums"
                title="从最后一句发言到主持人开口（尚未开口时为到本提示出现）的耗时"
              >
                响应 {seconds(driftAlert.speechStartMs ?? driftAlert.latencyMs)}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <Button
              size="sm"
              variant="outline"
              className="h-6 px-2.5 text-xs gap-1 border-amber-600/50 bg-transparent hover:bg-amber-500/10"
              onClick={handleUndo}
              title="不该打断：立即停止主持人的发言，让发言人继续"
            >
              <Undo2 className="w-3 h-3" />
              撤销打断
            </Button>
            <button
              onClick={() => updateMeetingLiveState({ driftAlert: null })}
              className="underline hover:opacity-80 text-muted-foreground text-xs"
            >
              关闭
            </button>
          </div>
        </div>
      )}

      {driftSuggestion && (
        <div
          role="alert"
          className="w-full py-2 px-3 sm:px-4 bg-amber-500/10 border border-dashed border-amber-500/50 rounded-lg flex flex-wrap items-center justify-between gap-2 text-amber-700 dark:text-amber-400 text-xs shadow-sm"
        >
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 min-w-0">
            <span className="flex items-center gap-1.5 font-semibold">
              <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
              疑似跑题：{driftSuggestion.reason || "讨论疑似偏离当前议题"}
            </span>
            <span className="text-[11px] opacity-80">
              {driftSourceLabels[driftSuggestion.source] ??
                driftSuggestion.source}
              　·　半自动模式，等待你决定
            </span>
            {typeof driftSuggestion.confidence === "number" && (
              <span className="text-[11px]">
                <ConfidenceBar value={driftSuggestion.confidence} />
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <Button
              size="sm"
              className="h-6 px-2.5 text-xs bg-amber-600 hover:bg-amber-700 text-white font-medium gap-1"
              onClick={handleConfirmSuggestion}
            >
              <Zap className="w-3 h-3" />
              打断并引导
            </Button>
            <button
              onClick={handleDismissSuggestion}
              className="underline hover:opacity-80 text-muted-foreground text-xs"
              title="没有跑题：记为一次误判，用于之后调整阈值"
            >
              忽略
            </button>
          </div>
        </div>
      )}

      {overtimeAlert && (
        <div className="w-full py-2 px-3 sm:px-4 bg-blue-500/10 border border-blue-500/30 rounded-lg flex flex-wrap items-center justify-between gap-2 text-blue-700 dark:text-blue-400 text-xs shadow-sm">
          <span className="flex items-center gap-1.5 font-semibold min-w-0">
            <Clock className="w-3.5 h-3.5 flex-shrink-0" />
            议题超时提醒：{overtimeAlert.reason}
          </span>
          <div className="flex items-center gap-2 flex-shrink-0">
            <Button
              size="sm"
              variant="outline"
              className="h-6 px-2.5 text-xs gap-1 border-blue-500/40 bg-transparent hover:bg-blue-500/10"
              onClick={handleForceIntervene}
              title="让 AI 主持人开口收拢讨论"
            >
              <Zap className="w-3 h-3" />
              呼叫主持人收拢
            </Button>
            <button
              onClick={() => updateMeetingLiveState({ overtimeAlert: null })}
              className="underline hover:opacity-80 text-muted-foreground text-xs"
            >
              关闭
            </button>
          </div>
        </div>
      )}

      {showPrevious && previousSession && (
        <div className="w-full py-2 px-3 sm:px-4 bg-muted/50 border border-border rounded-lg flex flex-wrap items-center justify-between gap-2 text-xs">
          <span className="flex items-center gap-1.5 min-w-0 text-muted-foreground">
            <History className="w-3.5 h-3.5 flex-shrink-0" />
            <span className="truncate">
              上一场会议的记录已保存在本机：
              <strong className="text-foreground">
                {previousSession.config.topic}
              </strong>
              （{new Date(previousSession.startedAt).toLocaleString()}，
              {previousSession.liveState.decisions.length} 条决议）
            </span>
          </span>
          <div className="flex items-center gap-2 flex-shrink-0">
            <Button
              size="sm"
              variant="outline"
              className="h-6 px-2.5 text-xs"
              onClick={onOpenPreviousSession}
            >
              查看并生成纪要
            </Button>
            <button
              onClick={dismissPreviousSession}
              className="underline hover:opacity-80 text-muted-foreground text-xs"
            >
              关闭
            </button>
          </div>
        </div>
      )}
    </>
  );
}
