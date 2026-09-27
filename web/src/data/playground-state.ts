import { ModalitiesId } from "@/data/modalities";
import { VoiceId } from "@/data/voices";
import { Preset } from "./presets";
import { DEFAULT_MODEL_ID, ModelId } from "./models";

import {
  MeetingConfig,
  defaultMeetingConfig,
  generateMeetingInstructions,
} from "./meeting";

export interface SessionConfig {
  model: ModelId;
  modalities: ModalitiesId;
  voice: VoiceId;
  temperature: number;
  maxOutputTokens: number | null;
  meetingConfig?: MeetingConfig;
}

export interface PlaygroundState {
  sessionConfig: SessionConfig;
  userPresets: Preset[];
  selectedPresetId: string | null;
  geminiAPIKey: string | null | undefined;
  /** 服务端 .env.local 已配置 GEMINI_API_KEY 时为 true，此时用户无需自己填写 */
  geminiKeyFromEnv: boolean;
  instructions: string;
}

export const defaultSessionConfig: SessionConfig = {
  model: DEFAULT_MODEL_ID,
  modalities: ModalitiesId.AUDIO_ONLY,
  voice: VoiceId.PUCK,
  temperature: 0.8,
  maxOutputTokens: null,
};

// Define the initial state.
// This must stay consistent with the "meeting-moderator" preset in ./presets:
// nothing dispatches SET_SELECTED_PRESET_ID on first load, so the app renders
// straight from this object. If selectedPresetId named the meeting preset but
// sessionConfig carried no meetingConfig, the kanban would not render at all.
export const defaultPlaygroundState: PlaygroundState = {
  sessionConfig: {
    ...defaultSessionConfig,
    voice: VoiceId.AOEDE,
    meetingConfig: defaultMeetingConfig,
  },
  userPresets: [],
  selectedPresetId: "meeting-moderator",
  geminiAPIKey: undefined,
  geminiKeyFromEnv: false,
  instructions: generateMeetingInstructions(defaultMeetingConfig),
};
