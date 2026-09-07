"use client";

import * as React from "react";
import { Play, Square, Loader2 } from "lucide-react";
import {
  playVoicePreview,
  stopVoicePreview,
  VoicePreviewError,
} from "@/data/voice-preview";
import { useToast } from "@/hooks/use-toast";
import { usePlaygroundState } from "@/hooks/use-playground-state";
import { cn } from "@/lib/utils";

/**
 * 试听当前音色。首次合成后由服务端磁盘缓存 + 会话内内存缓存复用，
 * 同一音色不会重复消耗 API 额度。
 */
export function VoicePreviewButton({
  voice,
  className,
}: {
  voice?: string;
  className?: string;
}) {
  const [loading, setLoading] = React.useState(false);
  const [playing, setPlaying] = React.useState(false);
  const { toast } = useToast();
  const { pgState, setShowAuthDialog } = usePlaygroundState();

  // 切换音色时停掉上一条试听，避免听到的和显示的对不上
  React.useEffect(() => {
    stopVoicePreview();
    setPlaying(false);
  }, [voice]);

  React.useEffect(() => () => stopVoicePreview(), []);

  const handleClick = async () => {
    if (!voice) return;
    if (playing) {
      stopVoicePreview();
      setPlaying(false);
      return;
    }
    // 不预先拦密钥：已缓存的音色无需密钥即可试听，只有首次合成才真的需要
    setLoading(true);
    try {
      await playVoicePreview(voice, pgState.geminiAPIKey, () =>
        setPlaying(false)
      );
      setPlaying(true);
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
      setLoading(false);
    }
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={!voice || loading}
      aria-label={playing ? "停止试听" : "试听当前音色"}
      title={playing ? "停止试听" : "试听当前音色"}
      className={cn(
        "h-8 w-8 shrink-0 rounded-md border flex items-center justify-center transition-colors",
        playing
          ? "border-fgAccent1 text-fgAccent1 bg-fgAccent1/10"
          : "border-separator1 text-fg2 hover:text-fg0 hover:border-fg3",
        loading && "opacity-60 cursor-wait",
        className
      )}
    >
      {loading ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : playing ? (
        <Square className="h-3 w-3 fill-current" />
      ) : (
        <Play className="h-3.5 w-3.5 fill-current" />
      )}
    </button>
  );
}
