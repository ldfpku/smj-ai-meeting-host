export enum ModelId {
  // Native audio models
  GEMINI_3_8_LIVE = "gemini-3.8-live",
  GEMINI_3_8_LIVE_EXTENDED_THINKING = "gemini-3.8-live-extended-thinking",
  GEMINI_3_1_FLASH_LIVE_PREVIEW = "gemini-3.1-flash-live-preview",
}

export const DEFAULT_MODEL_ID = ModelId.GEMINI_3_8_LIVE;

export enum ModelCategory {
  NATIVE_AUDIO = "原生语音",
}

export interface Model {
  id: ModelId;
  name: string;
  description: string;
  category: ModelCategory;
  isNew?: boolean;
  /** 只能输出语音；文字来自输出转写。对应 agent/model_caps.py 的 audio_only */
  audioOnly: boolean;
  /** 是否接受温度参数。对应 agent/model_caps.py 的 send_temperature */
  supportsTemperature: boolean;
}

export const modelsData: Record<ModelId, Model> = {
  [ModelId.GEMINI_3_8_LIVE]: {
    id: ModelId.GEMINI_3_8_LIVE,
    name: "Gemini 3.8 Live",
    description: "延迟最低；讨论切题时能保持静默，只在需要时开口（推荐）",
    category: ModelCategory.NATIVE_AUDIO,
    isNew: true,
    audioOnly: true,
    supportsTemperature: false,
  },
  [ModelId.GEMINI_3_8_LIVE_EXTENDED_THINKING]: {
    id: ModelId.GEMINI_3_8_LIVE_EXTENDED_THINKING,
    name: "Gemini 3.8 Live（深度思考）",
    description: "开口前思考更充分，判断更稳，但响应更慢",
    category: ModelCategory.NATIVE_AUDIO,
    isNew: true,
    audioOnly: true,
    supportsTemperature: false,
  },
  [ModelId.GEMINI_3_1_FLASH_LIVE_PREVIEW]: {
    id: ModelId.GEMINI_3_1_FLASH_LIVE_PREVIEW,
    name: "Gemini 3.1 Flash Live",
    description: "上一代预览模型，每轮发言都会回应；仅作备选",
    category: ModelCategory.NATIVE_AUDIO,
    isNew: false,
    audioOnly: false,
    supportsTemperature: true,
  },
};

export const models: Model[] = Object.values(modelsData);

export const modelsByCategory: Record<ModelCategory, Model[]> = {
  [ModelCategory.NATIVE_AUDIO]: models.filter(m => m.category === ModelCategory.NATIVE_AUDIO),
};

/**
 * 存量预设、分享链接里可能还留着已下线的模型 ID（如 2.5 原生语音预览版）。
 * 认不出的一律落到默认模型，与 agent 端 resolve_model 的回退保持一致。
 */
export function normalizeModelId(id: unknown): ModelId {
  return Object.values(ModelId).includes(id as ModelId)
    ? (id as ModelId)
    : DEFAULT_MODEL_ID;
}
