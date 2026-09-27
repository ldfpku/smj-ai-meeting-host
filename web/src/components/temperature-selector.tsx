"use client";

import * as React from "react";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import {
  FormField,
  FormControl,
  FormItem,
  FormLabel,
} from "@/components/ui/form";
import { Slider } from "@/components/ui/slider";
import {
  ConfigurationFormFieldProps,
  ConfigurationFormSchema,
} from "@/components/configuration-form";
import { Input } from "@/components/ui/input";
import { modelsData, normalizeModelId } from "@/data/models";
import { z } from "zod";

const getMinMaxForField = (schema: z.ZodNumber) => {
  return {
    minValue: schema.minValue ?? undefined,
    maxValue: schema.maxValue ?? undefined,
  };
};

export function TemperatureSelector({
  form,
  schema,
  ...props
}: ConfigurationFormFieldProps) {
  const { minValue, maxValue } = getMinMaxForField(
    ConfigurationFormSchema.shape.temperature,
  );
  const model = modelsData[normalizeModelId(form.watch("model"))];

  // Gemini 3.8 Live 不接受温度参数，agent 也不会把它发给模型
  if (!model.supportsTemperature) {
    return (
      <div className="pb-2 px-1">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-fg1">温度</span>
          <span className="text-sm text-fg2">由模型自动控制</span>
        </div>
        <p className="text-xs text-fg2 mt-1">{model.name} 不支持调整温度。</p>
      </div>
    );
  }

  return (
    <div
      className="pb-2"
    >
      <FormField
        control={form.control}
        name="temperature"
        render={({ field }) => (
          <HoverCard openDelay={200}>
            <HoverCardTrigger asChild>
              <FormItem className="px-1">
                <div className="flex items-center justify-between">
                  <FormLabel className="text-sm font-medium text-fg1">温度</FormLabel>
                  <FormControl>
                    <Input
                      {...field}
                      type="number"
                      className="w-[100px]"
                    />
                  </FormControl>
                </div>
                <FormControl className="mt-2">
                  <Slider
                    max={maxValue}
                    min={minValue}
                    defaultValue={[form.formState.defaultValues!.temperature!]}
                    step={0.01}
                    onValueChange={(v) => field.onChange(v[0])}
                    value={[field.value]}
                    className="pt-2 [&_[role=slider]]:h-4 [&_[role=slider]]:w-4"
                    aria-label="温度"
                  />
                </FormControl>
              </FormItem>
            </HoverCardTrigger>
            <HoverCardContent align="start" className="w-[260px] text-sm" side="right">
              调整回复的随机程度。降低温度会让回复更确定、更趋于重复。
            </HoverCardContent>
          </HoverCard>
        )}
      />
    </div>
  );
}
