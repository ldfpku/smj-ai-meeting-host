"use client";

import * as React from "react";
import {
  FormField,
  FormControl,
  FormItem,
  FormLabel,
} from "@/components/ui/form";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import { Switch } from "@/components/ui/switch";
import { ConfigurationFormFieldProps } from "@/components/configuration-form";

export function NanoBananaToggle({ form }: ConfigurationFormFieldProps) {
  const [hoverCardOpen, setHoverCardOpen] = React.useState(false);

  return (
    <FormField
      control={form.control}
      name="nanoBananaEnabled"
      render={({ field }) => (
        <FormItem className="flex flex-row items-center space-y-0 justify-between px-1">
          <FormLabel className="text-sm font-medium text-fg1">
            🍌 Nano Banana
          </FormLabel>
          <HoverCard openDelay={200} open={hoverCardOpen} onOpenChange={setHoverCardOpen}>
            <HoverCardTrigger asChild>
              <div>
                <FormControl>
                  <Switch
                    checked={field.value}
                    onCheckedChange={field.onChange}
                    aria-label="启用 Nano Banana 图像生成"
                  />
                </FormControl>
              </div>
            </HoverCardTrigger>
            <HoverCardContent
              align="start"
              className="w-[260px] text-sm"
              side="right"
            >
              <div className="space-y-2">
                <p className="font-semibold text-fg0">Imagen 4 集成</p>
                <p className="text-fg2">
                  使用 Google Imagen 4 模型生成图像。启用后，主持人可以根据你的需求创建可视内容。
                </p>
              </div>
            </HoverCardContent>
          </HoverCard>
        </FormItem>
      )}
    />
  );
}

