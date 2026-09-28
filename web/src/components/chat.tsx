"use client";

import { useState, useEffect } from "react";
import { Instructions } from "@/components/instructions";
import { SessionControls } from "@/components/session-controls";
import { ConnectButton } from "./connect-button";
import { ConnectionState } from "livekit-client";
import { motion, AnimatePresence } from "framer-motion";
import {
  useConnectionState,
  useVoiceAssistant,
} from "@livekit/components-react";
import { ChatControls } from "@/components/chat-controls";
import { useAgent } from "@/hooks/use-agent";
import { useConnection } from "@/hooks/use-connection";
import { toast } from "@/hooks/use-toast";
import { SmjarVisualizer } from "@/components/visualizer/smjar-visualizer";
import { MeetingKanban } from "@/components/meeting/meeting-kanban";
import { MeetingConfigModal } from "@/components/meeting/meeting-config-modal";
import { MeetingAlerts } from "@/components/meeting/meeting-alerts";
import { TranscriptPanel } from "@/components/meeting/transcript-panel";
import {
  MinutesDialog,
  MinutesSource,
} from "@/components/meeting/minutes-dialog";
import { defaultMeetingConfig } from "@/data/meeting";
import { meetingStore } from "@/lib/meeting-store";
import { usePlaygroundState } from "@/hooks/use-playground-state";
import { useDemo } from "@/hooks/use-demo";
import { DemoPanel } from "@/components/demo/demo-panel";
import { Button } from "@/components/ui/button";
import { Clapperboard } from "lucide-react";

export function Chat() {
  const connectionState = useConnectionState();
  const { audioTrack, state } = useVoiceAssistant();
  const [isChatRunning, setIsChatRunning] = useState(false);
  const {
    agent,
    meetingLiveState,
    updateMeetingLiveState,
    transcript,
    previousSession,
  } = useAgent();
  const { disconnect } = useConnection();
  const { pgState } = usePlaygroundState();
  const demo = useDemo();
  const [isEditingInstructions, setIsEditingInstructions] = useState(false);
  const [showMeetingConfigModal, setShowMeetingConfigModal] = useState(false);
  const [showPreviousMinutes, setShowPreviousMinutes] = useState(false);
  // 以「是否配置了会议」为准，而非预设 id：把会议配置挂到别的预设上时也应渲染看板
  const isMeetingPreset = !!pgState.sessionConfig.meetingConfig;

  const [hasSeenAgent, setHasSeenAgent] = useState(false);

  useEffect(() => {
    let disconnectTimer: NodeJS.Timeout | undefined;
    let appearanceTimer: NodeJS.Timeout | undefined;

    if (connectionState === ConnectionState.Connected && !agent) {
      appearanceTimer = setTimeout(() => {
        disconnect();
        setHasSeenAgent(false);

        toast({
          title: "主持人不可用",
          description: "当前无法连接到 AI 主持人，请稍后重试。",
          variant: "destructive",
        });
      }, 5000);
    }

    if (agent) {
      setHasSeenAgent(true);
    }

    if (
      connectionState === ConnectionState.Connected &&
      !agent &&
      hasSeenAgent
    ) {
      // Agent disappeared while connected, wait 5s before disconnecting
      disconnectTimer = setTimeout(() => {
        if (!agent) {
          disconnect();
          setHasSeenAgent(false);
        }

        toast({
          title: "主持人已断开",
          description: "AI 主持人意外离开了会话，请重试。",
          variant: "destructive",
        });
      }, 5000);
    }

    setIsChatRunning(
      connectionState === ConnectionState.Connected && hasSeenAgent
    );

    return () => {
      if (disconnectTimer) clearTimeout(disconnectTimer);
      if (appearanceTimer) clearTimeout(appearanceTimer);
    };
  }, [connectionState, agent, disconnect, hasSeenAgent]);

  const toggleInstructionsEdit = () =>
    setIsEditingInstructions(!isEditingInstructions);

  const renderVisualizer = () => (
    <div className="flex w-full items-center">
      <div className="h-[280px] lg:h-[400px] mt-16 md:mt-0 lg:pb-24 w-full">
        <SmjarVisualizer 
          key={audioTrack?.publication?.trackSid || 'no-track'} 
          agentState={state} 
          agentTrackRef={audioTrack} 
        />
      </div>
    </div>
  );

  // 会议模式下左栏还要放转写面板，可视化区域收矮一些
  const renderMeetingVisualizer = () => (
    <div className="h-[140px] xl:h-[170px] w-full">
      <SmjarVisualizer
        key={audioTrack?.publication?.trackSid || 'no-track'}
        agentState={state}
        agentTrackRef={audioTrack}
      />
    </div>
  );

  // 上一场会议的纪要：数据来自本机保存的记录
  const loadPreviousSession = async (): Promise<MinutesSource> => {
    const session = previousSession!;
    const segments = await meetingStore.getSegments(session.id);
    return {
      config: session.config,
      liveState: session.liveState,
      elapsedSeconds: session.liveState.elapsedSeconds,
      transcript: segments.map((s) => ({ role: s.role, text: s.text, at: s.at })),
      startedAt: session.startedAt,
    };
  };

  const renderConnectionControl = () => (
    <AnimatePresence mode="wait">
      <motion.div
        key={isChatRunning ? "session-controls" : "connect-button"}
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 10 }}
        transition={{ type: "tween", duration: 0.15, ease: "easeInOut" }}
      >
        {demo.status !== "idle" && demo.status !== "done" ? null : isChatRunning ? (
          <SessionControls />
        ) : (
          <div className="flex items-center gap-2">
            <ConnectButton />
            {isMeetingPreset && (
              <Button
                variant="outline"
                className="text-sm font-semibold h-9 gap-2"
                onClick={demo.start}
                title="由合成语音扮演四位参会人，自动开一场约 4 分钟的会，演示主持人的全部功能"
              >
                <Clapperboard className="h-4 w-4" />
                演示会议
              </Button>
            )}
          </div>
        )}
      </motion.div>
    </AnimatePresence>
  );

  return (
    <div className="flex flex-col h-full overflow-hidden p-2 lg:p-4 min-w-0">
      <ChatControls
        showEditButton={isChatRunning}
        isEditingInstructions={isEditingInstructions}
        onToggleEdit={toggleInstructionsEdit}
      />
      {/* min-h-0 all the way down: without it a long transcript makes these
          boxes as tall as their content, the page clips them, and the
          transcript can neither scroll nor show its newest line */}
      <div className="flex flex-col flex-1 min-h-0 items-center lg:justify-between mt-12 lg:mt-0 min-w-0 w-full">
        <div className="w-full flex-1 min-h-0 flex flex-col min-w-0 gap-4">
          {/* 跑题打断 / 半自动建议 / 议题超时 / 上一场会议记录 */}
          {isMeetingPreset && (
            <MeetingAlerts
              onOpenPreviousSession={() => setShowPreviousMinutes(true)}
            />
          )}

          {/* 会议主持人模式：双栏看板布局 */}
          {isMeetingPreset ? (
            <>
              {/* Mobile: 纵向堆叠 */}
              <div className="lg:hidden w-full min-w-0 min-h-0 flex-1 flex flex-col gap-4 overflow-y-auto [&>*]:flex-shrink-0">
                {demo.status === "idle" ? (
                  <Instructions />
                ) : (
                  <DemoPanel className="h-[260px] flex-shrink-0" />
                )}
                {renderVisualizer()}
                <TranscriptPanel
                  transcript={transcript}
                  startedAt={meetingLiveState.startTime}
                  className="h-[240px] flex-shrink-0"
                />
                <div className="h-[480px]">
                  <MeetingKanban
                    config={pgState.sessionConfig.meetingConfig || defaultMeetingConfig}
                    liveState={meetingLiveState}
                    onAdvanceAgenda={(nextIdx) =>
                      updateMeetingLiveState({
                        currentAgendaIndex: nextIdx,
                        calledAttendeeIds: [],
                        spokenAttendeeIds: [],
                      })
                    }
                    onToggleSpoken={(attendeeId) =>
                      updateMeetingLiveState({
                        spokenAttendeeIds: meetingLiveState.spokenAttendeeIds.includes(
                          attendeeId
                        )
                          ? meetingLiveState.spokenAttendeeIds.filter(
                              (id) => id !== attendeeId
                            )
                          : [...meetingLiveState.spokenAttendeeIds, attendeeId],
                      })
                    }
                    onOpenConfigModal={() => setShowMeetingConfigModal(true)}
                    isConnectingOrConnected={
                      isChatRunning || connectionState === ConnectionState.Connected
                    }
                  />
                </div>
              </div>

              {/* Desktop: 左右双栏布局 */}
              <div className="hidden lg:grid lg:grid-cols-12 lg:grid-rows-[minmax(0,1fr)] lg:gap-4 lg:flex-1 lg:min-h-0 lg:min-w-0 w-full overflow-hidden">
                <div className="lg:col-span-5 flex flex-col h-full min-h-0 min-w-0 gap-3">
                  {demo.status === "idle" ? (
                    <div className="flex items-center justify-center w-full min-w-0">
                      <Instructions />
                    </div>
                  ) : (
                    <DemoPanel className="h-[300px] flex-shrink-0" />
                  )}
                  <div className="flex-shrink-0 flex items-center justify-center min-w-0">
                    <div className="w-full min-w-0">
                      {!isEditingInstructions && renderMeetingVisualizer()}
                    </div>
                  </div>
                  <TranscriptPanel
                    transcript={transcript}
                    startedAt={meetingLiveState.startTime}
                    className="flex-1"
                  />
                </div>
                <div className="lg:col-span-7 h-full min-h-0 overflow-hidden">
                  <MeetingKanban
                    config={pgState.sessionConfig.meetingConfig || defaultMeetingConfig}
                    liveState={meetingLiveState}
                    onAdvanceAgenda={(nextIdx) =>
                      updateMeetingLiveState({
                        currentAgendaIndex: nextIdx,
                        calledAttendeeIds: [],
                        spokenAttendeeIds: [],
                      })
                    }
                    onToggleSpoken={(attendeeId) =>
                      updateMeetingLiveState({
                        spokenAttendeeIds: meetingLiveState.spokenAttendeeIds.includes(
                          attendeeId
                        )
                          ? meetingLiveState.spokenAttendeeIds.filter(
                              (id) => id !== attendeeId
                            )
                          : [...meetingLiveState.spokenAttendeeIds, attendeeId],
                      })
                    }
                    onOpenConfigModal={() => setShowMeetingConfigModal(true)}
                    isConnectingOrConnected={
                      isChatRunning || connectionState === ConnectionState.Connected
                    }
                  />
                </div>
              </div>
            </>
          ) : (
            <>
              {/* Mobile: Show instructions and visualizer stacked */}
              <div className="lg:hidden w-full min-w-0 flex flex-col gap-4">
                <Instructions />
                {renderVisualizer()}
              </div>

              {/* Desktop: Show instructions at top, visualizer in middle */}
              <div className="hidden lg:flex lg:flex-col lg:h-full lg:min-w-0 w-full">
                <div className="flex items-center justify-center w-full min-w-0">
                  <Instructions />
                </div>
                <div className="grow h-full flex items-center justify-center min-w-0">
                  <div className="w-full min-w-0">
                    {!isEditingInstructions && renderVisualizer()}
                  </div>
                </div>
              </div>
            </>
          )}
        </div>

        <div className="my-4 flex-shrink-0">{renderConnectionControl()}</div>
      </div>

      <MeetingConfigModal
        open={showMeetingConfigModal}
        onOpenChange={setShowMeetingConfigModal}
      />
      {previousSession && (
        <MinutesDialog
          open={showPreviousMinutes}
          onOpenChange={setShowPreviousMinutes}
          getSource={loadPreviousSession}
        />
      )}
    </div>
  );
}
