import { useCallback } from "react";
import { useMaybeRoomContext } from "@livekit/components-react";
import { useAgent } from "@/hooks/use-agent";
import { useToast } from "@/hooks/use-toast";

/**
 * 向 AI 主持人发 RPC。成功返回解析后的响应，失败返回 null 并弹出提示。
 *
 * performRpc 必须指定具体的目标身份；主持人尚未进入房间时没有身份可填。
 */
export function useAgentRpc() {
  const room = useMaybeRoomContext();
  const { agent } = useAgent();
  const { toast } = useToast();

  return useCallback(
    async (
      method: string,
      payload: Record<string, unknown> = {}
    ): Promise<Record<string, any> | null> => {
      if (!room?.localParticipant || !agent?.identity) {
        toast({
          title: "主持人尚未就位",
          description: "AI 主持人还没有连接到会议，请稍候重试。",
          variant: "destructive",
        });
        return null;
      }
      try {
        const response = await room.localParticipant.performRpc({
          destinationIdentity: agent.identity,
          method,
          payload: JSON.stringify(payload),
        });
        try {
          return JSON.parse(response);
        } catch {
          return {};
        }
      } catch (err) {
        console.error(`${method} RPC failed`, err);
        toast({
          title: "指令未送达主持人",
          description: "AI 主持人未响应本次操作，请重试。",
          variant: "destructive",
        });
        return null;
      }
    },
    [room, agent?.identity, toast]
  );
}
