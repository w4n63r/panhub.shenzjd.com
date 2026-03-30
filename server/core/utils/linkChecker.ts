import { fetchWithRetry } from './fetch';

/**
 * 广谱网盘链接有效性验活嗅探器
 * @param url 网盘分享链接
 * @param diskType 预期的网盘类型 (可选)
 */
export async function checkDiskLinkAlive(url: string, diskType?: string): Promise<{ alive: boolean | null, reason: string }> {
  try {
    if (!url) return { alive: null, reason: 'Empty URL' };

    // 磁力链与 eD2k 这类 P2P 协议无法通过 HTTP 探活，直接放行
    if (url.startsWith('magnet:') || url.startsWith('ed2k://')) {
      return { alive: null, reason: 'P2P Protocol unsupported' };
    }

    // 智能推断真实网盘介质类型
    let type = diskType || 'others';
    if (type === 'others' || !type) {
      if (url.includes('baidu.com')) type = 'baidu';
      else if (url.includes('aliyundrive.com') || url.includes('alipan.com')) type = 'aliyun';
      else if (url.includes('quark.cn')) type = 'quark';
      else if (url.includes('xunlei.com')) type = 'xunlei';
      else if (url.includes('123pan.com') || url.includes('123pan.cn')) type = '123';
      else if (url.includes('189.cn')) type = 'tianyi';
      else if (url.includes('115.com')) type = '115';
      else if (url.includes('139.com')) type = 'mobile';
      else if (url.includes('lanzou')) type = 'lanzou';
    }

    // 伪装浏览器发起探测请求 (Fetch)
    // 注意：有些网盘分享页返回的是 404 statusCode，有些返回的是 200 HTTP 然后用前端渲染报错。
    // fetchWithRetry 会内部帮我们处理好标准的 User-Agent。
    const html: any = await fetchWithRetry(url, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache'
      }
    }, { maxRetries: 1, timeout: 6000 });

    const htmlStr = typeof html === 'string' ? html : JSON.stringify(html);

    // 【1】百度网盘
    if (type === 'baidu') {
      if (htmlStr.includes('啊哦，你来晚了') || htmlStr.includes('分享已取消') || htmlStr.includes('链接错误') || htmlStr.includes('分享不存在')) {
        return { alive: false, reason: '百度网盘分享已失效' };
      }
      return { alive: true, reason: 'Active' };
    }

    // 【2】阿里云盘
    if (type === 'aliyun') {
      if (htmlStr.includes('<title>分享失效') || htmlStr.includes('该分享已被删除') || htmlStr.includes('页面丢失') || htmlStr.includes('分享链接不存在') || htmlStr.includes('已失效或被撤销')) {
        return { alive: false, reason: '阿里云盘分享已失效' };
      }
      return { alive: true, reason: 'Active' };
    }

    // 【3】夸克网盘
    if (type === 'quark') {
      if (htmlStr.includes('出错啦') || htmlStr.includes('记录不存在') || htmlStr.includes('已被取消分享') || htmlStr.includes('该分享已失效')) {
        return { alive: false, reason: '夸克网盘分享已失效' };
      }
      return { alive: true, reason: 'Active' };
    }

    // 【4】迅雷网盘
    if (type === 'xunlei') {
      if (htmlStr.includes('提取码错误') || htmlStr.includes('失效') || htmlStr.includes('分享已被取消') || htmlStr.includes('不存在')) {
        return { alive: false, reason: '迅雷网盘分享已失效' };
      }
      return { alive: true, reason: 'Active' };
    }

    // 【5】123网盘
    if (type === '123') {
      if (htmlStr.includes('文件已被取消分享') || htmlStr.includes('页面找不到了') || htmlStr.includes('失效') || htmlStr.includes('不存在')) {
        return { alive: false, reason: '123网盘分享已失效' };
      }
      return { alive: true, reason: 'Active' };
    }

    // 【6】天翼云盘 / 移动云盘
    if (type === 'tianyi' || type === 'mobile') {
      if (htmlStr.includes('分享已失效') || htmlStr.includes('访问的页面不存在') || htmlStr.includes('取消分享')) {
        return { alive: false, reason: '云盘分享已失效' };
      }
      return { alive: true, reason: 'Active' };
    }
    
    // 【兜底通用匹配】防漏网之鱼
    if (htmlStr.includes('分享已失效') || htmlStr.includes('分享已取消') || htmlStr.includes('链接已失效') || htmlStr.includes('页面不存在') || htmlStr.includes('404 Not Found')) {
      return { alive: false, reason: '该资源分享链接已失效' };
    }

    // 若无明显死亡特征，则默认存活
    return { alive: true, reason: 'Active' };

  } catch (error: any) {
    const errStr = error?.toString() || '';
    
    // 如果 fetch 抛出了 404/403 等彻底致命的 HTTP 原生异常状态码
    if (errStr.includes('404') || error?.response?.status === 404) {
      return { alive: false, reason: '404 资源已被彻底删除' }
    }
    
    // 超时、DNS阻断等原因无法探测，保守放行
    return { alive: null, reason: `无法验证: ${error?.message || '网络异常'}` };
  }
}
