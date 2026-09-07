export enum ModalitiesId {
  TEXT_AND_AUDIO = "text_and_audio",
  TEXT_ONLY = "text_only",
  AUDIO_ONLY = "audio_only",
}

export interface Modalities {
  id: ModalitiesId;
  name: string;
  description: string;
}

export const modalities: Modalities[] = [
  {
    id: ModalitiesId.TEXT_AND_AUDIO,
    name: "文本与语音",
    description: "模型将同时输出语音和文本。",
  },
  {
    id: ModalitiesId.TEXT_ONLY,
    name: "仅文本",
    description: "模型将仅输出文本。",
  },
  {
    id: ModalitiesId.AUDIO_ONLY,
    name: "仅语音",
    description: "模型将仅输出语音。",
  },
];
