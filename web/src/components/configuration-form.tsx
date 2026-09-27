"use client";

import { useEffect, useCallback, useRef } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Form } from "@/components/ui/form";
import { SessionConfig } from "@/components/session-config";
import { VoiceId } from "@/data/voices";
import { ModelId } from "@/data/models";
import { UseFormReturn } from "react-hook-form";
import { usePlaygroundState } from "@/hooks/use-playground-state";
import { useConnection } from "@/hooks/use-connection";
import {
  useConnectionState,
  useLocalParticipant,
  useVoiceAssistant,
} from "@livekit/components-react";
import { ConnectionState } from "livekit-client";
import { defaultSessionConfig } from "@/data/playground-state";
import { useToast } from "@/hooks/use-toast";
import { ModalitiesId } from "@/data/modalities";

// Configuration changes that require full reconnection instead of hot-reload
const RECONNECT_REQUIRED_FIELDS = ["voice"];

export const ConfigurationFormSchema = z.object({
  model: z.nativeEnum(ModelId),
  modalities: z.nativeEnum(ModalitiesId),
  voice: z.nativeEnum(VoiceId),
  temperature: z.number().min(0.6).max(1.2),
  maxOutputTokens: z.number().nullable(),
});

export interface ConfigurationFormFieldProps {
  form: UseFormReturn<z.infer<typeof ConfigurationFormSchema>>;
  schema?: typeof ConfigurationFormSchema;
}

export function ConfigurationForm() {
  const { pgState, dispatch } = usePlaygroundState();
  const { connect, disconnect } = useConnection();
  const connectionState = useConnectionState();
  const { localParticipant } = useLocalParticipant();
  const form = useForm<z.infer<typeof ConfigurationFormSchema>>({
    resolver: zodResolver(ConfigurationFormSchema),
    defaultValues: { ...defaultSessionConfig },
    mode: "onChange",
  });
  const formValues = form.watch();
  const debounceTimeoutRef = useRef<NodeJS.Timeout | null>(null); // Ref to track timeout
  const hasConnectedOnceRef = useRef(false); // Track if we've connected once
  const isReconnectingRef = useRef(false); // Track if we're currently reconnecting to prevent loops
  // The config the agent is currently running with
  const lastSentRef = useRef<{ [key: string]: string | number | boolean } | null>(null);
  const { toast } = useToast();
  const { agent } = useVoiceAssistant();

  const updateConfig = useCallback(async () => {
    // Don't update if we're currently reconnecting to prevent loops
    if (isReconnectingRef.current) {
      console.log("Skipping config update - reconnection in progress");
      return;
    }

    const values = pgState.sessionConfig;
    const attributes: { [key: string]: string | number | boolean } = {
      instructions: pgState.instructions,
      model: values.model,
      voice: values.voice,
      modalities: values.modalities,
      temperature: values.temperature,
      max_output_tokens: values.maxOutputTokens || "",
      meeting_config: values.meetingConfig ? JSON.stringify(values.meetingConfig) : "",
    };
    // 只有用户在界面里填过密钥才带上；密钥配在服务端时这里没有值，
    // 发一个空串过去会把 agent 正在用的密钥冲掉。
    if (pgState.geminiAPIKey) {
      attributes.gemini_api_key = pgState.geminiAPIKey;
    }
    if (!agent?.identity) {
      return;
    }

    // Skip the very first update right after connection
    // (config was already sent via token)
    if (!hasConnectedOnceRef.current) {
      hasConnectedOnceRef.current = true;
      lastSentRef.current = attributes;
      return;
    }

    // 与「上一次已经生效的配置」比较。配置是随 token 的 metadata 下发的，
    // 从未写进 participant attributes；拿 attributes 做比较时每个字段都是
    // undefined，于是任何改动都会被判成「音色变了」而整场重连。
    const lastSent = lastSentRef.current ?? {};
    const changed = (key: string) =>
      String(attributes[key] ?? "") !== String(lastSent[key] ?? "");

    const hasChanges = Object.keys(attributes).some(changed);

    if (!hasChanges) {
      console.log("no changes");
      return;
    }

    // Check if any critical fields changed that require full reconnection
    const hasCriticalChanges = RECONNECT_REQUIRED_FIELDS.some(changed);

    if (hasCriticalChanges) {
      console.log("Critical config change detected, triggering reconnection...");
      
      // Set reconnecting flag to prevent update loops
      isReconnectingRef.current = true;
    
      try {
        // Trigger full reconnection
        await disconnect();
        // Small delay to ensure clean disconnect
        await new Promise(resolve => setTimeout(resolve, 500));
        
        // Reset the connection flag so the first update after reconnect is skipped
        hasConnectedOnceRef.current = false;
        
        await connect();
        
        // Wait a bit longer for the connection to stabilize and attributes to sync
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        toast({
          title: "已重新连接",
          description: "会话已按新设置重新连接。",
          variant: "success",
        });
      } catch (e) {
        toast({
          title: "重新连接失败",
          description: "无法重新连接，请手动重试。",
          variant: "destructive",
        });
      } finally {
        // Always reset the reconnecting flag
        isReconnectingRef.current = false;
      }
      return;
    }

    console.log("has changes, sending RPC");

    try {
      let response = await localParticipant.performRpc({
        destinationIdentity: agent.identity,
        method: "pg.updateConfig",
        payload: JSON.stringify(attributes),
      });
      console.log("pg.updateConfig", response);
      lastSentRef.current = attributes;
      let responseObj = JSON.parse(response);
      // 只改了介入设置时 agent 原地生效（restarted=false），那条提示由看板给出
      if (responseObj.changed && responseObj.restarted !== false) {
        toast({
          title: "配置已更新",
          variant: "success",
        });
      }
    } catch (e) {
      toast({
        title: "更新配置出错",
        description: "更新配置时发生错误，请重试。",
        variant: "destructive",
      });
    }
  }, [
    pgState.sessionConfig,
    pgState.instructions,
    pgState.geminiAPIKey,
    localParticipant,
    toast,
    agent?.identity,
    connect,
    disconnect,
  ]);

  // Function to debounce updates when user stops interacting
  const handleDebouncedUpdate = useCallback(() => {
    if (debounceTimeoutRef.current) {
      clearTimeout(debounceTimeoutRef.current); // Clear existing timeout
    }

    // Set a new timeout to perform the update after 500ms of inactivity
    debounceTimeoutRef.current = setTimeout(() => {
      updateConfig();
    }, 500); // Adjust delay as needed
  }, [updateConfig]);

  // Reset connection flag when disconnected
  useEffect(() => {
    if (connectionState !== ConnectionState.Connected) {
      hasConnectedOnceRef.current = false;
      lastSentRef.current = null;
      // Don't reset isReconnectingRef here - it's managed by the reconnection flow
    }
  }, [connectionState]);

  // Propagate form upates from the user
  useEffect(() => {
    if (form.formState.isValid && form.formState.isDirty) {
      dispatch({
        type: "SET_SESSION_CONFIG",
        payload: formValues,
      });
    }
  }, [formValues, dispatch, form]);

  useEffect(() => {
    if (ConnectionState.Connected === connectionState) {
      handleDebouncedUpdate(); // Call debounced update when form changes
    }

    form.reset(pgState.sessionConfig);
  }, [pgState.sessionConfig, connectionState, handleDebouncedUpdate, form]);

  return (
    <Form {...form}>
      <form className="h-full">
        <div className="flex flex-col h-full">
          <div className="flex-shrink-0 py-4 px-1 border-b border-separator1">
            <div className="text-xs font-bold uppercase tracking-widest text-fg0">
              配置
            </div>
          </div>
          <div className="flex-grow overflow-y-auto py-4 pt-4">
            <div className="space-y-5">
              <SessionConfig form={form} />
            </div>
          </div>
        </div>
      </form>
    </Form>
  );
}
