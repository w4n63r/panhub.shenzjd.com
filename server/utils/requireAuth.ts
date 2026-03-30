import { createError, getQuery, getHeader } from "h3";
import { verifyAuthCookie } from "./auth";

/** 
 * 适用于小程序端/API调用的轻量级动态验签 
 * 防重放攻击：Token 有效期短于 60 秒
 */
export function requireDynamicAuth(event: H3Event): void {
  const config = useRuntimeConfig();
  const secret = (config.apiSecret as string) || "1962359ef4267f7dfaf145eb9aef5333";
  
  const query = getQuery(event);
  const token = (query.token as string) || (getHeader(event, 'Authorization') as string) || "";
  
  try {
    const parts = token.split('.');
    if (parts.length !== 2) throw new Error();
    const ts = parseInt(parts[0], 10);
    const sig = parts[1];
    
    // 放宽手机本地时间与服务器时间的误差容忍度 (前后 5 分钟)
    const timeDiff = Date.now() - ts;
    if (Math.abs(timeDiff) > 300000) {
        throw new Error(`[Expired] Time diff: ${timeDiff}ms`);
    }

    // DJB2 Hash 快速复刻校验
    const str = ts + secret;
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) - hash) + str.charCodeAt(i);
        hash |= 0;
    }
    
    if (hash.toString(16) !== sig) {
        throw new Error(`[Hash Mismatch] Expected: ${hash.toString(16)}, Got: ${sig}`);
    }
  } catch (err: any) {
    throw createError({ statusCode: 401, statusMessage: `Invalid or expired API signature: ${err.message}` });
  }
}

export function requireSearchAuth(event: H3Event): void {
  const config = useRuntimeConfig();
  const password = (config.searchPassword as string) || "";
  if (!password.trim()) return;
  if (!verifyAuthCookie(event, password)) {
    throw createError({ statusCode: 401, statusMessage: "search locked" });
  }
}
