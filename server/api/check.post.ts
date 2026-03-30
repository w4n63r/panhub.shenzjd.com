import { defineEventHandler, readBody, getQuery } from 'h3';
import { checkDiskLinkAlive } from '../core/utils/linkChecker';
import { requireDynamicAuth } from '../utils/requireAuth';

export default defineEventHandler(async (event) => {
  try {
    requireDynamicAuth(event);
    
    // 防御性提取 Body (针对不同请求头的兼容)
    let body: any = {};
    if (event.node.req.method === 'POST') {
      try {
        body = await readBody(event) || {};
      } catch (e) {}
    }
    
    // 降级支援 Query 参数提取
    const query = getQuery(event) || {};
    
    // 合并寻址
    const url = body?.url || query?.url;
    const type = body?.type || query?.type;

    // 非空校验防御
    if (!url || typeof url !== 'string' || url.trim() === '') {
      return { 
        code: -1, 
        msg: 'URL parameter is missing or invalid', 
        debug_body: body, 
        debug_query: query 
      };
    }

    const result = await checkDiskLinkAlive(url, type);

    return {
      code: 0,
      data: {
        is_alive: result.alive,
        reason: result.reason
      }
    };
  } catch (error: any) {
    return {
      code: -1,
      msg: 'Internal Server Error',
      error: error?.message || String(error)
    };
  }
});
