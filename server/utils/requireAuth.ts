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
    
    // 60秒过期防重放
    if (Date.now() - ts > 60000 || Date.now() - ts < -5000) throw new Error();

    // DJB2 Hash 快速复刻校验
    const str = ts + secret;
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) - hash) + str.charCodeAt(i);
        hash |= 0;
    }
    
    if (hash.toString(16) !== sig) throw new Error();
  } catch {
    throw createError({ statusCode: 401, statusMessage: "Invalid or expired API signature" });
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
