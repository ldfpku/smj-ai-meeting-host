import path from "node:path";
import dotenv from "dotenv";

// 密钥放在仓库根目录的 .env.local（与 /api/token 一致）
dotenv.config({ path: path.join(process.cwd(), "../.env.local") });

/**
 * 告诉前端服务端是否已配置 GEMINI_API_KEY。
 * 只回布尔值，绝不把密钥本身发给浏览器。
 */
export async function GET() {
  return Response.json(
    { configured: !!process.env.GEMINI_API_KEY?.trim() },
    { headers: { "Cache-Control": "no-store" } }
  );
}
