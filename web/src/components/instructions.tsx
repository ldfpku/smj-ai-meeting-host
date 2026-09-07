"use client";

import { useState } from "react";
import { InstructionsEditor } from "@/components/instructions-editor";
import { usePlaygroundState } from "@/hooks/use-playground-state";
import { playgroundStateHelpers } from "@/lib/playground-state-helpers";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import { CircleHelp, ChevronDown, ChevronRight } from "lucide-react";

export function Instructions() {
  const [isFocused, setIsFocused] = useState<boolean>(false);
  const [isOpen, setIsOpen] = useState<boolean>(false);
  const [isExpanded, setIsExpanded] = useState<boolean>(false);
  const { pgState } = usePlaygroundState();
  
  const immutablePrompt = playgroundStateHelpers.getImmutablePrompt(pgState);

  return (
    <div
      className={`flex flex-1 flex-col w-full min-w-0 gap-[4px] text-brand-fg bg-brand-surface border border-brand-border shadow-sm p-4 rounded-lg overflow-y-auto overflow-x-hidden`}
    >
      <div className="flex justify-between items-center mb-2">
        <div className="flex items-center">
          <div className="text-xs font-semibold uppercase mr-1 tracking-widest">
            系统指令
          </div>
          <HoverCard open={isOpen}>
            <HoverCardTrigger asChild>
              <CircleHelp
                className="h-4 w-4 cursor-pointer"
                onClick={() => setIsOpen(!isOpen)}
              />
            </HoverCardTrigger>
            <HoverCardContent
              className="w-[260px] text-sm"
              side="bottom"
              onInteractOutside={() => setIsOpen(false)}
            >
              系统指令是一段系统消息，模型每次响应前都会把它置于对话最前面。修改后将在下一轮对话中生效。
              {immutablePrompt && (
                <>
                  <br /><br />
                  <strong>注意：</strong>Nano Banana 会为图像生成追加额外指令。
                </>
              )}
            </HoverCardContent>
          </HoverCard>
        </div>
      </div>
      
      <InstructionsEditor
        instructions={pgState.instructions}
        onFocus={() => setIsFocused(true)}
        onBlur={() => setIsFocused(false)}
      />
      
      {immutablePrompt && (
        <div className="mt-2">
          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className="flex items-center gap-1 text-xs text-brand-fg/70 hover:text-brand-fg transition-colors"
          >
            {isExpanded ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
            <span>已包含 Nano Banana 追加指令</span>
          </button>
          {isExpanded && (
            <div className="mt-2 p-2 text-xs font-mono leading-loose text-brand-fg/60 whitespace-pre-wrap">
              {immutablePrompt}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
