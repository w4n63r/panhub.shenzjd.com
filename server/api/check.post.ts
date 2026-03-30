import { defineEventHandler, readBody } from 'h3';
import { checkDiskLinkAlive } from '../core/utils/linkChecker';

export default defineEventHandler(async (event) => {
  try {
    const body = await readBody(event);
    const { url, type } = body || {};

    if (!url || typeof url !== 'string') {
      return { code: -1, msg: 'URL parameter is missing or invalid' };
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
