"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Info, Check, Play, Square, Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { voices, VoiceId } from "@/data/voices";
import {
  VOICE_PREVIEW_TEXT,
  playVoicePreview,
  stopVoicePreview,
  VoicePreviewError,
} from "@/data/voice-preview";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { usePlaygroundState } from "@/hooks/use-playground-state";

interface VoicesShowcaseProps {
  onSelectVoice?: (voiceId: VoiceId) => void;
  currentVoice?: VoiceId;
  onOpenChange?: (open: boolean) => void;
}

export function VoicesShowcase({
  onSelectVoice,
  currentVoice,
  onOpenChange,
}: VoicesShowcaseProps) {
  const [open, setOpen] = useState(false);
  const [loadingVoice, setLoadingVoice] = useState<string | null>(null);
  const [playingVoice, setPlayingVoice] = useState<string | null>(null);
  const { toast } = useToast();
  const { pgState, setShowAuthDialog } = usePlaygroundState();

  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen) {
      stopVoicePreview();
      setPlayingVoice(null);
    }
    setOpen(newOpen);
    onOpenChange?.(newOpen);
  };

  const handlePreview = async (voiceId: VoiceId) => {
    // 正在播这条 → 再点就是停止
    if (playingVoice === voiceId) {
      stopVoicePreview();
      setPlayingVoice(null);
      return;
    }
    // 不预先拦密钥：已缓存的音色无需密钥即可试听，只有首次合成才真的需要
    stopVoicePreview();
    setPlayingVoice(null);
    setLoadingVoice(voiceId);
    try {
      await playVoicePreview(voiceId, pgState.geminiAPIKey, () =>
        setPlayingVoice(null)
      );
      setPlayingVoice(voiceId);
    } catch (err) {
      const missingKey =
        err instanceof VoicePreviewError && err.code === "MISSING_API_KEY";
      toast({
        title: missingKey ? "需要 Gemini API 密钥" : "试听失败",
        description:
          err instanceof Error ? err.message : "无法合成该音色的示例语音。",
        variant: "destructive",
      });
      if (missingKey) setShowAuthDialog(true);
    } finally {
      setLoadingVoice(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          aria-label="查看并试听全部音色"
        >
          <Info className="h-4 w-4" />
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-4xl max-h-[85vh] flex flex-col p-0">
        <div className="px-6 py-5 border-b border-separator1">
          <DialogHeader>
            <DialogTitle className="text-2xl font-semibold text-fg0">
              可用音色
            </DialogTitle>
            <DialogDescription className="text-base text-fg1 mt-2">
              共 {voices.length} 种音色。点击 ▶ 先试听，再决定用哪一个。
            </DialogDescription>
          </DialogHeader>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {voices.map((voice) => {
              const isSelected = currentVoice === voice.id;
              const isLoading = loadingVoice === voice.id;
              const isPlaying = playingVoice === voice.id;
              return (
                <div
                  key={voice.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => {
                    onSelectVoice?.(voice.id);
                    handleOpenChange(false);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onSelectVoice?.(voice.id);
                      handleOpenChange(false);
                    }
                  }}
                  className={cn(
                    "flex items-center justify-between gap-2 p-4 rounded-lg border transition-all text-left cursor-pointer",
                    isSelected
                      ? "border-fgAccent1 bg-bg2 ring-2 ring-fgAccent1/20"
                      : "border-separator1 bg-bg0 hover:bg-bg2 hover:border-fg3"
                  )}
                >
                  <div className="flex-1 min-w-0 flex items-center gap-2">
                    <h3 className="text-sm font-semibold text-fg0 truncate">
                      {voice.name}
                    </h3>
                    {isSelected && (
                      <Check className="h-4 w-4 text-fgAccent1 shrink-0" />
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Badge variant="secondary" className="text-xs">
                      {voice.characteristic}
                    </Badge>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        handlePreview(voice.id);
                      }}
                      disabled={isLoading}
                      aria-label={`试听 ${voice.name}`}
                      title={isPlaying ? "停止试听" : `试听 ${voice.name}`}
                      className={cn(
                        "h-7 w-7 rounded-full border flex items-center justify-center transition-colors",
                        isPlaying
                          ? "border-fgAccent1 text-fgAccent1 bg-fgAccent1/10"
                          : "border-separator1 text-fg2 hover:text-fg0 hover:border-fg3",
                        isLoading && "opacity-60 cursor-wait"
                      )}
                    >
                      {isLoading ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : isPlaying ? (
                        <Square className="h-3 w-3 fill-current" />
                      ) : (
                        <Play className="h-3.5 w-3.5 fill-current" />
                      )}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="px-6 py-4 border-t border-separator1 bg-bg1 space-y-1.5">
          <p className="text-xs text-fg2">
            试听示例：{VOICE_PREVIEW_TEXT}
          </p>
          <p className="text-xs text-fg3">
            示例台词取自主持人打断跑题的实际场景，便于判断这个音色够不够有权威感。
            每个音色首次试听会调用一次 Gemini 语音合成并缓存到本地，之后再听不再消耗额度。
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
