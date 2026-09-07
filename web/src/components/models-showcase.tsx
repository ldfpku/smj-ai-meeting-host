"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Info, Check, Sparkles } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { models, ModelId, ModelCategory, modelsByCategory } from "@/data/models";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

interface ModelsShowcaseProps {
  onSelectModel?: (modelId: ModelId) => void;
  currentModel?: ModelId;
  onOpenChange?: (open: boolean) => void;
}

export function ModelsShowcase({ onSelectModel, currentModel, onOpenChange }: ModelsShowcaseProps) {
  const [open, setOpen] = useState(false);

  const handleOpenChange = (newOpen: boolean) => {
    setOpen(newOpen);
    onOpenChange?.(newOpen);
  };

  const getCategoryDescription = (category: ModelCategory) => {
    if (category === ModelCategory.NATIVE_AUDIO) {
      return "语音最自然，支持情绪感知对话、主动发声与思考能力";
    }
    return "级联架构，在生产环境中性能与可靠性更佳，尤其适合工具调用场景";
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          aria-label="查看全部模型"
        >
          <Info className="h-4 w-4" />
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-4xl max-h-[85vh] flex flex-col p-0">
        <div className="px-6 py-5 border-b border-separator1">
          <DialogHeader>
            <DialogTitle className="text-2xl font-semibold text-fg0">
              可用模型
            </DialogTitle>
            <DialogDescription className="text-base text-fg1 mt-2">
              从 {models.length} 个为实时交互优化的 Gemini 模型中选择。
            </DialogDescription>
          </DialogHeader>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4">
          <div className="space-y-6">
            {Object.entries(modelsByCategory).map(([category, categoryModels]) => (
              <div key={category} className="space-y-3">
                <div className="space-y-1">
                  <h3 className="text-sm font-bold uppercase tracking-widest text-fg0">
                    {category}
                  </h3>
                  <p className="text-xs text-fg2">
                    {getCategoryDescription(category as ModelCategory)}
                  </p>
                </div>
                <div className="grid grid-cols-1 gap-3">
                  {categoryModels.map((model) => {
                    const isSelected = currentModel === model.id;
                    return (
                      <button
                        key={model.id}
                        onClick={() => {
                          onSelectModel?.(model.id);
                          setOpen(false);
                        }}
                        className={cn(
                          "flex flex-col gap-2 p-4 rounded-lg border transition-all text-left",
                          isSelected
                            ? "border-fgAccent1 bg-bg2 ring-2 ring-fgAccent1/20"
                            : "border-separator1 bg-bg0 hover:bg-bg2 hover:border-fg3"
                        )}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex-1 min-w-0 space-y-1">
                            <div className="flex items-center gap-2">
                              <h4 className="text-sm font-semibold text-fg0">
                                {model.name}
                              </h4>
                              {model.isNew && (
                                <Badge variant="default" className="text-xs gap-1 bg-fgAccent1 text-bg0">
                                  <Sparkles className="h-3 w-3" />
                                  新
                                </Badge>
                              )}
                            </div>
                            <p className="text-xs text-fg2">
                              {model.description}
                            </p>
                          </div>
                          {isSelected && (
                            <Check className="h-5 w-5 text-fgAccent1 shrink-0 mt-0.5" />
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="px-6 py-4 border-t border-separator1 bg-bg1">
          <p className="text-xs text-fg2">
            <span className="font-semibold">提示：</span>原生音频模型的语音最自然，但延迟可能更高；
            半级联模型针对使用工具的生产场景做了优化。
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}

