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
  useRoomContext,
} from "@livekit/components-react";
import { Button } from "@/components/ui/button";
import { ChatControls } from "@/components/chat-controls";
import { useAgent } from "@/hooks/use-agent";
import { useConnection } from "@/hooks/use-connection";
import { toast } from "@/hooks/use-toast";
import { GeminiVisualizer } from "@/components/visualizer/gemini-visualizer";
import { NanoBananaFeed } from "@/components/nano-banana-feed";
import { MeetingKanban } from "@/components/meeting/meeting-kanban";
import { MeetingConfigModal } from "@/components/meeting/meeting-config-modal";
import { defaultMeetingConfig, playAttentionChime } from "@/data/meeting";
import { usePlaygroundState } from "@/hooks/use-playground-state";

export function Chat() {
  const connectionState = useConnectionState();
  const { audioTrack, state } = useVoiceAssistant();
  const [isChatRunning, setIsChatRunning] = useState(false);
  const { agent, meetingLiveState, updateMeetingLiveState } = useAgent();
  const { disconnect } = useConnection();
  const { pgState } = usePlaygroundState();
  const [isEditingInstructions, setIsEditingInstructions] = useState(false);
  const [showMeetingConfigModal, setShowMeetingConfigModal] = useState(false);
  const isMeetingPreset = pgState.selectedPresetId === "meeting-moderator";
  const room = useRoomContext();

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
      console.log("forceIntervene RPC error", err);
    }
  };

  const [hasSeenAgent, setHasSeenAgent] = useState(false);

  useEffect(() => {
    let disconnectTimer: NodeJS.Timeout | undefined;
    let appearanceTimer: NodeJS.Timeout | undefined;

    if (connectionState === ConnectionState.Connected && !agent) {
      appearanceTimer = setTimeout(() => {
        disconnect();
        setHasSeenAgent(false);

        toast({
          title: "Agent Unavailable",
          description:
            "Unable to connect to an agent right now. Please try again later.",
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
          title: "Agent Disconnected",
          description:
            "The AI agent has unexpectedly left the conversation. Please try again.",
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
        <GeminiVisualizer 
          key={audioTrack?.publication?.trackSid || 'no-track'} 
          agentState={state} 
          agentTrackRef={audioTrack} 
        />
      </div>
    </div>
  );

  const renderConnectionControl = () => (
    <AnimatePresence mode="wait">
      <motion.div
        key={isChatRunning ? "session-controls" : "connect-button"}
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 10 }}
        transition={{ type: "tween", duration: 0.15, ease: "easeInOut" }}
      >
        {isChatRunning ? <SessionControls /> : <ConnectButton />}
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
      <div className="flex flex-col flex-grow items-center lg:justify-between mt-12 lg:mt-0 min-w-0 w-full">
        <div className="w-full h-full flex flex-col min-w-0 gap-4">
          {/* 跑题早期介入黄灯预警 Banner */}
          {isMeetingPreset && meetingLiveState.driftWarning && (
            <div className="w-full py-2 px-3 sm:px-4 bg-amber-500/15 border border-amber-500/40 rounded-lg flex items-center justify-between text-amber-600 dark:text-amber-400 text-xs font-semibold shadow-sm">
              <div className="flex items-center gap-2 min-w-0">
                <span className="truncate">⚠️ 跑题黄灯预警：AI 主持人检测到讨论疑似偏离当前议题，请注意聚焦！</span>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0 ml-2">
                <Button
                  size="sm"
                  variant="destructive"
                  className="h-6 px-2.5 text-xs bg-amber-600 hover:bg-amber-700 text-white font-medium flex items-center gap-1"
                  onClick={handleForceIntervene}
                >
                  ⚡ 呼叫主持即刻打断
                </Button>
                <button
                  onClick={() => updateMeetingLiveState({ driftWarning: false })}
                  className="underline hover:opacity-80 text-muted-foreground ml-1 text-xs"
                >
                  忽略
                </button>
              </div>
            </div>
          )}

          {/* 会议主持人模式：双栏看板布局 */}
          {isMeetingPreset ? (
            <>
              {/* Mobile: 纵向堆叠 */}
              <div className="lg:hidden w-full min-w-0 flex flex-col gap-4 overflow-y-auto">
                <Instructions />
                {renderVisualizer()}
                <div className="h-[480px]">
                  <MeetingKanban
                    config={pgState.sessionConfig.meetingConfig || defaultMeetingConfig}
                    liveState={meetingLiveState}
                    onAdvanceAgenda={(nextIdx) =>
                      updateMeetingLiveState({ currentAgendaIndex: nextIdx })
                    }
                    onOpenConfigModal={() => setShowMeetingConfigModal(true)}
                    isConnectingOrConnected={
                      isChatRunning || connectionState === ConnectionState.Connected
                    }
                  />
                </div>
              </div>

              {/* Desktop: 左右双栏布局 */}
              <div className="hidden lg:grid lg:grid-cols-12 lg:gap-4 lg:h-full lg:min-w-0 w-full overflow-hidden">
                <div className="lg:col-span-5 flex flex-col h-full min-w-0 justify-between">
                  <div className="flex items-center justify-center w-full min-w-0">
                    <Instructions />
                  </div>
                  <div className="grow h-full flex items-center justify-center min-w-0">
                    <div className="w-full min-w-0">
                      {!isEditingInstructions && renderVisualizer()}
                    </div>
                  </div>
                </div>
                <div className="lg:col-span-7 h-full min-h-0 overflow-hidden">
                  <MeetingKanban
                    config={pgState.sessionConfig.meetingConfig || defaultMeetingConfig}
                    liveState={meetingLiveState}
                    onAdvanceAgenda={(nextIdx) =>
                      updateMeetingLiveState({ currentAgendaIndex: nextIdx })
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

          <NanoBananaFeed />
        </div>

        <div className="my-4">{renderConnectionControl()}</div>
      </div>

      <MeetingConfigModal
        open={showMeetingConfigModal}
        onOpenChange={setShowMeetingConfigModal}
      />
    </div>
  );
}
