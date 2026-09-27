import { AccessToken } from "livekit-server-sdk";
import { RoomAgentDispatch, RoomConfiguration } from '@livekit/protocol';
import { PlaygroundState } from "@/data/playground-state";
import { normalizeModelId } from "@/data/models";
import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.join(process.cwd(), "../.env.local") });

// 本地开发时可设 LIVEKIT_AGENT_NAME（agent 与 web 两侧一致），
// 避免会话被分派到同一 LiveKit 项目下已部署的线上 agent。
const AGENT_NAME = process.env.LIVEKIT_AGENT_NAME?.trim() || "gemini-playground";

export async function POST(request: Request) {
  try {
    let playgroundState: PlaygroundState;

    try {
      playgroundState = await request.json();
    } catch (error) {
      return Response.json(
        { error: "Invalid JSON in request body" },
        { status: 400 }
      );
    }

    const {
      instructions,
      geminiAPIKey,
      sessionConfig: { model, modalities, voice, temperature, maxOutputTokens, meetingConfig },
    } = playgroundState;

    const serverHasGeminiKey = !!process.env.GEMINI_API_KEY?.trim();

    if (!serverHasGeminiKey && !geminiAPIKey) {
      return Response.json(
        { error: "未配置 Gemini API 密钥：请在根目录 .env.local 设置 GEMINI_API_KEY，或在界面中填写。" },
        { status: 400 }
      );
    }

    const roomName = Math.random().toString(36).slice(7);
    const apiKey = process.env.LIVEKIT_API_KEY;
    const apiSecret = process.env.LIVEKIT_API_SECRET;
    if (!apiKey || !apiSecret) {
      throw new Error("LIVEKIT_API_KEY and LIVEKIT_API_SECRET must be set");
    }

    // Create metadata for agent to start with
    const metadata: Record<string, unknown> = {
      instructions: instructions,
      model: normalizeModelId(model),
      modalities: modalities,
      voice: voice,
      temperature: temperature,
      max_output_tokens: maxOutputTokens,
      meeting_config: meetingConfig,
    };

    // 这份 metadata 会写进返回给浏览器的 JWT（只是 base64，并未加密），房间内其他
    // 参会人也读得到。服务端的密钥因此绝不能放进来：agent 从自己的环境变量读取。
    // 只有服务端没配密钥、用户在界面里填了自己的密钥时，才把用户那一把带给 agent。
    if (!serverHasGeminiKey && geminiAPIKey) {
      metadata.gemini_api_key = geminiAPIKey;
    }

    // Create access token
    const at = new AccessToken(apiKey, apiSecret, {
      identity: "human",
      metadata: JSON.stringify(metadata),
    });

    // Add room grants
    at.addGrant({
      room: roomName,
      roomJoin: true,
      canPublish: true,
      canPublishData: true,
      canSubscribe: true,
      canUpdateOwnMetadata: true,
    });

    // Create room configuration + dispatch agent
    at.roomConfig = new RoomConfiguration({
      name: roomName,
      agents: [
        new RoomAgentDispatch({
          agentName: AGENT_NAME,
        }),
      ],
    });
    return Response.json({
      accessToken: await at.toJwt(),
      url: process.env.LIVEKIT_URL,
      roomName,
    });
  } catch (error) {
    return Response.json(
      { error: "Error generating token", details: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
