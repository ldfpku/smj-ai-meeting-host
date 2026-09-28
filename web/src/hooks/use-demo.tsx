"use client";

import React, {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
} from "react";
import { useConnection } from "@/hooks/use-connection";
import { usePlaygroundState } from "@/hooks/use-playground-state";
import { useToast } from "@/hooks/use-toast";
import { generateMeetingInstructions, MeetingConfig } from "@/data/meeting";
import { DEMO_CONFIG } from "@/data/demo-meeting";
import { SimAudio } from "@/lib/demo/audio";
import {
  DemoEvent,
  DemoFinding,
  DemoLine,
  DemoRunner,
} from "@/lib/demo/runner";

/**
 * idle：没有演示；preparing：正在合成台词；connecting：正在进入会议；
 * running：会议进行中；done：已结束，面板上留着检查结果
 */
export type DemoStatus = "idle" | "preparing" | "connecting" | "running" | "done";

interface DemoContextType {
  status: DemoStatus;
  progress: { done: number; total: number };
  line: DemoLine | null;
  events: DemoEvent[];
  findings: DemoFinding[];
  /** 演示进行中：房间里的麦克风由合成语音代替，不采集真实麦克风 */
  active: boolean;
  audio: SimAudio | null;
  start: () => Promise<void>;
  /** 由房间内的组件在主持人就位后调用 */
  attach: (runner: DemoRunner) => void;
  stop: () => void;
  close: () => void;
  callbacks: {
    onEvent: (event: DemoEvent) => void;
    onLine: (line: DemoLine | null) => void;
  };
}

const DemoContext = createContext<DemoContextType | undefined>(undefined);

export function DemoProvider({ children }: { children: React.ReactNode }) {
  const { pgState, dispatch } = usePlaygroundState();
  const { connect, disconnect } = useConnection();
  const { toast } = useToast();

  const [status, setStatus] = useState<DemoStatus>("idle");
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [line, setLine] = useState<DemoLine | null>(null);
  const [events, setEvents] = useState<DemoEvent[]>([]);
  const [findings, setFindings] = useState<DemoFinding[]>([]);
  const [audio, setAudio] = useState<SimAudio | null>(null);
  // 会议刚结束、连接还没完全断开的那一小会儿，仍不采集真实麦克风
  const [releasing, setReleasing] = useState(false);

  const runnerRef = useRef<DemoRunner | null>(null);
  const audioRef = useRef<SimAudio | null>(null);
  // 演示前的会议配置，关闭演示时放回去
  const previousRef = useRef<{
    meetingConfig?: MeetingConfig;
    instructions: string;
  } | null>(null);

  const callbacks = useRef({
    onEvent: (event: DemoEvent) => setEvents((prev) => [...prev, event]),
    onLine: (next: DemoLine | null) => setLine(next),
  }).current;

  const releaseAudio = useCallback(() => {
    audioRef.current?.close();
    audioRef.current = null;
    setAudio(null);
  }, []);

  const start = useCallback(async () => {
    if (status !== "idle" && status !== "done") return;
    setEvents([]);
    setFindings([]);
    setLine(null);
    setProgress({ done: 0, total: 0 });
    setStatus("preparing");

    const sim = new SimAudio();
    audioRef.current = sim;
    try {
      // 必须在点击的这一刻恢复：浏览器不允许页面自己开始出声
      await sim.resume();
      await DemoRunner.prepare(sim, (done, total) =>
        setProgress({ done, total })
      );
    } catch (err) {
      releaseAudio();
      setStatus("idle");
      toast({
        title: "演示会议没有开始",
        description: err instanceof Error ? err.message : "台词合成失败。",
        variant: "destructive",
      });
      return;
    }

    if (!previousRef.current) {
      previousRef.current = {
        meetingConfig: pgState.sessionConfig.meetingConfig,
        instructions: pgState.instructions,
      };
    }
    const instructions = generateMeetingInstructions(DEMO_CONFIG);
    dispatch({
      type: "SET_SESSION_CONFIG",
      payload: { meetingConfig: DEMO_CONFIG },
    });
    dispatch({ type: "SET_INSTRUCTIONS", payload: instructions });

    setAudio(sim);
    setStatus("connecting");
    try {
      await connect({
        ...pgState,
        instructions,
        sessionConfig: { ...pgState.sessionConfig, meetingConfig: DEMO_CONFIG },
      });
    } catch (err) {
      releaseAudio();
      setStatus("done");
      toast({
        title: "演示会议没有开始",
        description: "无法进入会议，请稍后重试。",
        variant: "destructive",
      });
    }
  }, [status, pgState, dispatch, connect, toast, releaseAudio]);

  const attach = useCallback(
    (runner: DemoRunner) => {
      runnerRef.current = runner;
      setStatus("running");
      runner.run().then(async (result) => {
        runnerRef.current = null;
        setFindings(result);
        setReleasing(true);
        setStatus("done");
        console.log("[demo] findings", JSON.stringify(result, null, 1));
        await disconnect();
        releaseAudio();
        setTimeout(() => setReleasing(false), 2000);
      });
    },
    [disconnect, releaseAudio]
  );

  const stop = useCallback(() => {
    if (runnerRef.current) {
      runnerRef.current.stop();
      return;
    }
    // 还没开始就取消
    disconnect();
    releaseAudio();
    setStatus("done");
  }, [disconnect, releaseAudio]);

  const close = useCallback(() => {
    if (status !== "done") return;
    const previous = previousRef.current;
    previousRef.current = null;
    if (previous) {
      dispatch({
        type: "SET_SESSION_CONFIG",
        payload: { meetingConfig: previous.meetingConfig },
      });
      dispatch({ type: "SET_INSTRUCTIONS", payload: previous.instructions });
    }
    setStatus("idle");
  }, [status, dispatch]);

  return (
    <DemoContext.Provider
      value={{
        status,
        progress,
        line,
        events,
        findings,
        active: status === "connecting" || status === "running" || releasing,
        audio,
        start,
        attach,
        stop,
        close,
        callbacks,
      }}
    >
      {children}
    </DemoContext.Provider>
  );
}

export function useDemo() {
  const context = useContext(DemoContext);
  if (context === undefined) {
    throw new Error("useDemo must be used within a DemoProvider");
  }
  return context;
}
