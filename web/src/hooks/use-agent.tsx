import React, { createContext, useContext, useState, useEffect } from "react";
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
import { MeetingLiveState, playAttentionChime } from "@/data/meeting";

interface Transcription {
  segment: TranscriptionSegment;
  participant?: Participant;
  publication?: TrackPublication;
}

interface GeneratedImage {
  prompt: string;
  imageUrl: string;
  timestamp: number;
}

interface AgentContextType {
  displayTranscriptions: Transcription[];
  agent?: RemoteParticipant;
  generatedImages: GeneratedImage[];
  meetingLiveState: MeetingLiveState;
  updateMeetingLiveState: (partial: Partial<MeetingLiveState>) => void;
}

const defaultInitialMeetingLiveState: MeetingLiveState = {
  currentAgendaIndex: 0,
  startTime: null,
  elapsedSeconds: 0,
  decisions: [],
  isFinished: false,
  driftWarning: false,
};

const AgentContext = createContext<AgentContextType | undefined>(undefined);

export function AgentProvider({ children }: { children: React.ReactNode }) {
  const room = useMaybeRoomContext();
  const { shouldConnect } = useConnection();
  const { agent } = useVoiceAssistant();
  const { localParticipant } = useLocalParticipant();
  const [rawSegments, setRawSegments] = useState<{
    [id: string]: Transcription;
  }>({});
  const [displayTranscriptions, setDisplayTranscriptions] = useState<
    Transcription[]
  >([]);
  const [generatedImages, setGeneratedImages] = useState<GeneratedImage[]>([]);
  const [meetingLiveState, setMeetingLiveState] = useState<MeetingLiveState>(
    defaultInitialMeetingLiveState
  );
  const { toast } = useToast();

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
      if (topic === "meeting_update") {
        try {
          const text = new TextDecoder().decode(payload);
          const data = JSON.parse(text);
          console.log("Meeting update received:", data);
          setMeetingLiveState((prev) => {
            if (data.type === "new_decision") {
              const exists = prev.decisions.some((d) => d.id === data.decision.id);
              if (exists) return prev;
              return {
                ...prev,
                decisions: [...prev.decisions, data.decision],
              };
            }
            if (data.type === "advance_agenda") {
              return {
                ...prev,
                currentAgendaIndex: data.currentAgendaIndex,
                driftWarning: false,
              };
            }
            if (data.type === "drift_warning") {
              const active = data.active ?? true;
              if (active) {
                playAttentionChime();
              }
              return {
                ...prev,
                driftWarning: active,
              };
            }
            if (data.type === "state_sync") {
              return {
                ...prev,
                ...data.state,
              };
            }
            return { ...prev, ...data };
          });
        } catch (err) {
          console.error("Failed to decode meeting_update data", err);
        }
      }
    };

    room.on(RoomEvent.DataReceived, handleDataReceived);

    return () => {
      room.off(RoomEvent.DataReceived, handleDataReceived);
    };
  }, [room]);

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

  // Register byte stream handler for images
  useEffect(() => {
    if (!room || !shouldConnect) return;

    const handleByteStream = async (reader: any, participantInfo: any) => {
      try {
        console.log('Byte stream received:', reader.info);
        
        // Get the prompt from attributes
        const prompt = reader.info.attributes?.prompt || 'Generated image';
        const timestamp = reader.info.timestamp || Date.now();
        
        // Read all chunks from the stream
        const chunks = await reader.readAll();
        
        // Create a blob from the chunks
        const blob = new Blob(chunks, { type: reader.info.mimeType || 'image/jpeg' });
        const imageUrl = URL.createObjectURL(blob);
        
        // Add to generated images
        setGeneratedImages(prev => [
          ...prev,
          {
            prompt,
            imageUrl,
            timestamp
          }
        ]);
        
        console.log('Image received and processed:', prompt);
      } catch (error) {
        console.error('Failed to process byte stream:', error);
      }
    };

    room.registerByteStreamHandler('nano_banana_image', handleByteStream);

    return () => {
      room.unregisterByteStreamHandler('nano_banana_image');
    };
  }, [room, shouldConnect]);

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

  useEffect(() => {
    if (shouldConnect) {
      setRawSegments({});
      setDisplayTranscriptions([]);
      setGeneratedImages([]);
      setMeetingLiveState({
        ...defaultInitialMeetingLiveState,
        startTime: Date.now(),
      });
    }
  }, [shouldConnect]);

  return (
    <AgentContext.Provider
      value={{
        displayTranscriptions,
        agent,
        generatedImages,
        meetingLiveState,
        updateMeetingLiveState,
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
