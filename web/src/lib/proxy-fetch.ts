/**
 * 带代理的 fetch（仅服务端使用）。
 *
 * 为什么需要：Node 的全局 fetch 不认 HTTP_PROXY / HTTPS_PROXY 环境变量
 * （NODE_USE_ENV_PROXY 是 Node 24 才有的，本项目跑在 Node 22）。而 Gemini API
 * 对部分地区有访问限制，直连会返回：
 *   "This API is not available in your current location."
 * 本机已配置 HTTPS_PROXY，Python 侧（httpx/urllib 认环境变量）因此正常，
 * 只有 Node 侧直连被挡——这正是音色试听失败的真实原因。
 *
 * 为什么用 undici 自带的 fetch 而不是全局 fetch：
 * 全局 fetch 用的是 Node 内置的那份 undici，把**外部安装**的 undici 的
 * ProxyAgent 传给它会报 "invalid onRequestStart method"（两份 undici 的
 * dispatcher 接口不一致）。所以 fetch 与 dispatcher 必须来自同一份 undici。
 *
 * 注意：ALL_PROXY 常见为 socks5，undici 的 ProxyAgent 只支持 HTTP(S) 代理，
 * 因此这里只取 HTTPS_PROXY / HTTP_PROXY。
 *
 * 没有配置代理时（部署在 Cloudflare Workers 上就是这样）用运行环境自带的 fetch，
 * undici 只在确实要走代理时才加载：它依赖的 Node 网络接口在 Workers 上没有。
 */

function resolveProxyUrl(): string | undefined {
  const candidates = [
    process.env.HTTPS_PROXY,
    process.env.https_proxy,
    process.env.HTTP_PROXY,
    process.env.http_proxy,
  ];
  for (const c of candidates) {
    const v = c?.trim();
    if (v && /^https?:\/\//i.test(v)) return v;
  }
  return undefined;
}

// 只建一次，避免每个请求都新建连接池
let proxied: Promise<typeof fetch> | undefined;

async function loadProxiedFetch(url: string): Promise<typeof fetch> {
  const undici = await import("undici");
  const agent = new undici.ProxyAgent(url);
  console.log(`[proxy-fetch] 通过代理访问外部 API: ${url}`);
  return ((input: string | URL, init?: RequestInit) =>
    undici.fetch(input, {
      ...(init as object),
      dispatcher: agent,
    })) as unknown as typeof fetch;
}

/** 与 fetch 同签名；配置了 HTTP(S) 代理时自动走代理，否则直连 */
export async function proxyFetch(
  input: string | URL,
  init?: RequestInit
): Promise<Response> {
  const url = resolveProxyUrl();
  if (!url) return fetch(input, init);
  proxied ??= loadProxiedFetch(url);
  return (await proxied)(input, init);
}

export function isProxyConfigured(): boolean {
  return !!resolveProxyUrl();
}
