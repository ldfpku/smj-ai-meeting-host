import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  useMaybeRoomContext,
  useVoiceAssistant,
  useLocalParticipant,
} from "@livekit/components-react";
import {
  RoomEvent,
  TranscriptionSegment,
  Participant,
  TrackPublication,
  RemoteParticipant,
  type RpcInvocationData,
} from "livekit-client";
import { useConnection } from "@/hooks/use-connection";
import { useToast } from "@/hooks/use-toast";
import {
  MeetingLiveState,
  defaultInterventionSettings,
  playAttentionChime,
} from "@/data/meeting";
import {
  meetingStore,
  StoredIntervention,
  StoredSegment,
  StoredSession,
} from "@/lib/meeting-store";

interface Transcription {
  segment: TranscriptionSegment;
  participant?: Participant;
  publication?: TrackPublication;
}

/** 转写面板与纪要生成用的一条记录 */
export interface TranscriptEntry {
  id: string;
  /** moderator：AI 主持人；room：会场（暂不区分具体发言人） */
  role: "moderator" | "room";
  text: string;
  final: boolean;
  at: number;
}

interface AgentContextType {
  displayTranscriptions: Transcription[];
  transcript: TranscriptEntry[];
  interventions: StoredIntervention[];
  agent?: RemoteParticipant;
  meetingLiveState: MeetingLiveState;
  updateMeetingLiveState: (partial: Partial<MeetingLiveState>) => void;
  /** 本机保存的上一场会议（刷新或断开后仍可查看、生成纪要） */
  previousSession: StoredSession | null;
  dismissPreviousSession: () => void;
}

const defaultInitialMeetingLiveState: MeetingLiveState = {
  currentAgendaIndex: 0,
  startTime: null,
  elapsedSeconds: 0,
  decisions: [],
  openItems: [],
  calledAttendeeIds: [],
  spokenAttendeeIds: [],
  isFinished: false,
  driftAlert: null,
  driftSuggestion: null,
  overtimeAlert: null,
  driftScore: null,
  intervention: defaultInterventionSettings,
  detectorActive: false,
  ending: null,
  endedMessage: null,
};

/**
 * 是否是真正说出来的话。模型决定不发言时，仍可能交出一段"空"的输出：
 * 零宽字符、一个句点，或一条注释（如 <!-- 静默监听 -->）。这些不进转写。
 */
function isSpokenText(raw: string): boolean {
  const text = raw.replace(/[\s​-‍﻿]/g, "");
  if (!text || text === ".") return false;
  // 模型决定不说话时留下的占位：<!-- 静默监听 -->、<no speech detected>、（静默）
  return !/^(<[^>]*>|[（(][^）)]*[）)])$/.test(text);
}

const CJK = "\\u3000-\\u303f\\u4e00-\\u9fff\\uff00-\\uffef";
const SPACE_BETWEEN_CJK = new RegExp(`([${CJK}])\\s+(?=[${CJK}])`, "g");

/** Gemini 3.1 的转写会在每个汉字之间插入空格（"三 号 机"），显示和纪要都不需要它们。 */
function tidyTranscript(raw: string): string {
  return raw.trim().replace(SPACE_BETWEEN_CJK, "$1");
}

/** 把一条 meeting_update 消息折算成新的会议状态。纯函数，不产生副作用。 */
function reduceMeetingUpdate(
  prev: MeetingLiveState,
  data: any
): MeetingLiveState {
  switch (data.type) {
    case "new_decision": {
      // upsert：主持人补齐四要素后会用同一 id 再发一次
      const idx = prev.decisions.findIndex((d) => d.id === data.decision.id);
      if (idx === -1) {
        return { ...prev, decisions: [...prev.decisions, data.decision] };
      }
      const next = [...prev.decisions];
      next[idx] = data.decision;
      return { ...prev, decisions: next };
    }
    case "new_open_item": {
      // upsert：同一件事主持人再登记一次时（补了跟进人等）沿用原 id
      const idx = prev.openItems.findIndex((o) => o.id === data.openItem.id);
      if (idx === -1) {
        return { ...prev, openItems: [...prev.openItems, data.openItem] };
      }
      const next = [...prev.openItems];
      next[idx] = data.openItem;
      return { ...prev, openItems: next };
    }
    case "roll_call": {
      // 主持人点名了某位参会人：看板高亮，等待其表态
      const id: string | undefined = data.attendeeId;
      if (!id || prev.calledAttendeeIds.includes(id)) return prev;
      return { ...prev, calledAttendeeIds: [...prev.calledAttendeeIds, id] };
    }
    case "advance_agenda":
      // 换议题即重置本议题的点名/发言记录与各类提示
      return {
        ...prev,
        currentAgendaIndex: data.currentAgendaIndex,
        driftAlert: null,
        driftSuggestion: null,
        overtimeAlert: null,
        calledAttendeeIds: [],
        spokenAttendeeIds: [],
      };
    case "drift_warning":
      if (data.active === false) return { ...prev, driftAlert: null };
      return {
        ...prev,
        driftSuggestion: null,
        driftAlert: {
          interventionId: data.interventionId,
          source: data.source ?? "model",
          reason: data.reason ?? "",
          reasonCode: data.reasonCode,
          confidence: data.confidence ?? null,
          latencyMs: data.latencyMs ?? null,
          speechStartMs: null,
          at: Date.now(),
        },
      };
    case "drift_suggestion":
      return {
        ...prev,
        driftSuggestion: {
          suggestionId: data.suggestionId,
          source: data.source ?? "jev",
          reason: data.reason ?? "",
          reasonCode: data.reasonCode,
          confidence: data.confidence ?? null,
          expiresAt: data.expiresAt ?? Date.now() + 20000,
        },
      };
    case "intervention_metrics":
      if (
        !prev.driftAlert ||
        prev.driftAlert.interventionId !== data.interventionId
      ) {
        return prev;
      }
      return {
        ...prev,
        driftAlert: {
          ...prev.driftAlert,
          latencyMs: data.detectToPublishMs ?? prev.driftAlert.latencyMs,
          speechStartMs: data.speechStartMs ?? null,
        },
      };
    case "intervention_undone":
      return { ...prev, driftAlert: null };
    case "overtime_warning":
      return {
        ...prev,
        overtimeAlert: {
          agendaIndex: data.agendaIndex,
          title: data.title ?? "",
          reason: data.reason ?? "",
          at: Date.now(),
        },
      };
    case "drift_score":
      return {
        ...prev,
        driftScore: {
          confidence: data.confidence,
          level: data.level,
          reason: data.reason ?? "",
          reasonCode: data.reasonCode ?? "",
          jevMs: data.jevMs,
          threshold: data.threshold,
          at: Date.now(),
        },
      };
    case "intervention_settings":
      return {
        ...prev,
        intervention: { ...prev.intervention, ...data.intervention },
      };
    case "meeting_ending":
      if (data.active === false) return { ...prev, ending: null };
      return {
        ...prev,
        ending: {
          reason: data.reason === "limit" ? "limit" : "idle",
          message: data.message ?? "",
          endsAt: Date.now() + (data.secondsLeft ?? 60) * 1000,
        },
      };
    case "meeting_ended":
      return {
        ...prev,
        ending: null,
        isFinished: true,
        endedMessage: data.message ?? "会议已结束。",
      };
    case "state_sync":
      return { ...prev, ...data.state };
    default:
      // 不认识的消息一律忽略。此前这里把整条消息并进状态，
      // agent 每新增一种消息类型都会往会议状态里塞进无关字段。
      return prev;
  }
}

const AgentContext = createContext<AgentContextType | undefined>(undefined);

export function AgentProvider({ children }: { children: React.ReactNode }) {
  const room = useMaybeRoomContext();
  const { shouldConnect, roomName, pgState, disconnect } = useConnection();
  const { agent } = useVoiceAssistant();
  const { localParticipant } = useLocalParticipant();
  const [rawSegments, setRawSegments] = useState<{
    [id: string]: Transcription;
  }>({});
  const [displayTranscriptions, setDisplayTranscriptions] = useState<
    Transcription[]
  >([]);
  const [meetingLiveState, setMeetingLiveState] = useState<MeetingLiveState>(
    defaultInitialMeetingLiveState
  );
  const [interventions, setInterventions] = useState<StoredIntervention[]>([]);
  const [previousSession, setPreviousSession] = useState<StoredSession | null>(
    null
  );
  const { toast } = useToast();

  const meetingConfig = pgState.sessionConfig.meetingConfig;
  // 只有会议模式才落盘；当前会议的键就是房间名
  const sessionId = shouldConnect && meetingConfig ? roomName : "";
  const startedAtRef = useRef<number>(0);
  const savedSegmentsRef = useRef<Map<string, string>>(new Map());

  const updateMeetingLiveState = (partial: Partial<MeetingLiveState>) => {
    setMeetingLiveState((prev) => ({ ...prev, ...partial }));
  };

  useEffect(() => {
    if (!room) return;

    const handleDataReceived = (
      payload: Uint8Array,
      participant?: Participant,
      kind?: any,
      topic?: string
    ) => {
      if (topic !== "meeting_update") return;
      let data: any;
      try {
        data = JSON.parse(new TextDecoder().decode(payload));
      } catch (err) {
        console.error("Failed to decode meeting_update data", err);
        return;
      }
      if (data.type !== "drift_score" && data.type !== "state_sync") {
        console.log("Meeting update received:", data);
      }

      setMeetingLiveState((prev) => reduceMeetingUpdate(prev, data));

      // 副作用放在状态更新函数之外：提示音与介入记录
      if (data.type === "drift_warning" && data.active !== false) {
        playAttentionChime();
        setInterventions((prev) => [
          ...prev,
          {
            interventionId: data.interventionId,
            source: data.source ?? "model",
            reason: data.reason ?? "",
            confidence: data.confidence ?? null,
            latencyMs: data.latencyMs ?? null,
            speechStartMs: null,
            undone: false,
            at: Date.now(),
          },
        ]);
      } else if (data.type === "drift_suggestion") {
        playAttentionChime();
      } else if (data.type === "meeting_ending" && data.active !== false) {
        playAttentionChime();
      } else if (data.type === "meeting_ended") {
        // agent 随后会关闭房间；这里主动断开，麦克风立即停止采集
        toast({
          title: "会议已结束",
          description:
            (data.message ?? "") + " 转写和决议已保存在本机，可继续生成纪要。",
        });
        disconnect();
      } else if (data.type === "intervention_metrics") {
        setInterventions((prev) =>
          prev.map((i) =>
            i.interventionId === data.interventionId
              ? {
                  ...i,
                  latencyMs: data.detectToPublishMs ?? i.latencyMs,
                  speechStartMs: data.speechStartMs ?? null,
                }
              : i
          )
        );
      } else if (data.type === "intervention_undone") {
        setInterventions((prev) =>
          prev.map((i) =>
            i.interventionId === data.interventionId
              ? { ...i, undone: true }
              : i
          )
        );
      }
    };

    room.on(RoomEvent.DataReceived, handleDataReceived);

    return () => {
      room.off(RoomEvent.DataReceived, handleDataReceived);
    };
  }, [room, toast, disconnect]);

  useEffect(() => {
    if (!room) {
      return;
    }
    const updateRawSegments = (
      segments: TranscriptionSegment[],
      participant?: Participant,
      publication?: TrackPublication,
    ) => {
      setRawSegments((prev) => {
        const newSegments = { ...prev };
        for (const segment of segments) {
          newSegments[segment.id] = { segment, participant, publication };
        }
        return newSegments;
      });
    };
    room.on(RoomEvent.TranscriptionReceived, updateRawSegments);

    return () => {
      room.off(RoomEvent.TranscriptionReceived, updateRawSegments);
    };
  }, [room]);

  useEffect(() => {
    if (localParticipant) {
      localParticipant.registerRpcMethod(
        "pg.toast",
        async (data: RpcInvocationData) => {
          const { title, description, variant } = JSON.parse(data.payload);
          console.log(title, description, variant);
          toast({
            title,
            description,
            variant,
          });
          return JSON.stringify({ shown: true });
        },
      );
    }
  }, [localParticipant, toast]);

  useEffect(() => {
    const sorted = Object.values(rawSegments).sort(
      (a, b) =>
        (a.segment.firstReceivedTime ?? 0) - (b.segment.firstReceivedTime ?? 0),
    );
    const mergedSorted = sorted.reduce((acc, current) => {
      if (acc.length === 0) {
        return [current];
      }

      const last = acc[acc.length - 1];
      if (
        last.participant === current.participant &&
        last.participant?.isAgent &&
        (current.segment.firstReceivedTime ?? 0) -
        (last.segment.lastReceivedTime ?? 0) <=
        1000 &&
        !last.segment.id.startsWith("status-") &&
        !current.segment.id.startsWith("status-")
      ) {
        // Merge segments from the same participant if they're within 1 second of each other
        return [
          ...acc.slice(0, -1),
          {
            ...current,
            segment: {
              ...current.segment,
              text: `${last.segment.text} ${current.segment.text}`,
              id: current.segment.id, // Use the id of the latest segment
              firstReceivedTime: last.segment.firstReceivedTime, // Keep the original start time
            },
          },
        ];
      } else {
        return [...acc, current];
      }
    }, [] as Transcription[]);
    setDisplayTranscriptions(mergedSorted);
  }, [rawSegments]);

  const transcript = useMemo<TranscriptEntry[]>(
    () =>
      displayTranscriptions
        .filter(
          (t) =>
            !t.segment.id.startsWith("status-") &&
            isSpokenText(t.segment.text)
        )
        .map((t) => ({
          id: t.segment.id,
          role: t.participant?.isAgent ? "moderator" : "room",
          text: tidyTranscript(t.segment.text),
          final: t.segment.final,
          at: t.segment.firstReceivedTime || Date.now(),
        })),
    [displayTranscriptions]
  );

  useEffect(() => {
    if (shouldConnect) {
      setRawSegments({});
      setDisplayTranscriptions([]);
      setInterventions([]);
      savedSegmentsRef.current = new Map();
      startedAtRef.current = Date.now();
      setMeetingLiveState({
        ...defaultInitialMeetingLiveState,
        startTime: startedAtRef.current,
      });
    }
  }, [shouldConnect]);

  // ---- 本地持久化 ---------------------------------------------------------

  // 进入页面时找出本机保存的最近一场会议
  // （本页面里刚开过的那一场还在内存里、看板上，不算「上一场」）
  const lastSessionIdRef = useRef("");
  const refreshPreviousSession = useCallback(async () => {
    const sessions = await meetingStore.listSessions();
    setPreviousSession(
      sessions.find((s) => s.id !== lastSessionIdRef.current) ?? null
    );
  }, []);

  useEffect(() => {
    if (sessionId) lastSessionIdRef.current = sessionId;
    refreshPreviousSession();
  }, [sessionId, refreshPreviousSession]);

  // 转写：只写入新增或内容有变化的段
  useEffect(() => {
    if (!sessionId) return;
    const saved = savedSegmentsRef.current;
    const changed: StoredSegment[] = [];
    for (const entry of transcript) {
      const fingerprint = `${entry.final ? 1 : 0}:${entry.text}`;
      if (saved.get(entry.id) === fingerprint) continue;
      saved.set(entry.id, fingerprint);
      changed.push({
        sessionId,
        segmentId: entry.id,
        role: entry.role,
        text: entry.text,
        final: entry.final,
        at: entry.at,
      });
    }
    meetingStore.putSegments(changed);
  }, [sessionId, transcript]);

  // 会议状态：停止变化 1 秒后写入
  useEffect(() => {
    if (!sessionId || !meetingConfig) return;
    const timer = setTimeout(() => {
      meetingStore
        .saveSession({
          id: sessionId,
          config: meetingConfig,
          liveState: meetingLiveState,
          interventions,
          startedAt: startedAtRef.current || Date.now(),
          updatedAt: Date.now(),
        })
        .then(() => meetingStore.prune());
    }, 1000);
    return () => clearTimeout(timer);
  }, [sessionId, meetingConfig, meetingLiveState, interventions]);

  const dismissPreviousSession = useCallback(() => {
    setPreviousSession(null);
  }, []);

  return (
    <AgentContext.Provider
      value={{
        displayTranscriptions,
        transcript,
        interventions,
        agent,
        meetingLiveState,
        updateMeetingLiveState,
        previousSession,
        dismissPreviousSession,
      }}
    >
      {children}
    </AgentContext.Provider>
  );
}

export function useAgent() {
  const context = useContext(AgentContext);
  if (context === undefined) {
    throw new Error("useAgent must be used within an AgentProvider");
  }
  return context;
}
