/**
 * 全局搜索请求并发限制 + 请求去重
 *
 * 两层保护：
 * 1. Inflight dedup：相同关键词的搜索只执行一次，其他人等结果
 * 2. 并发限流：最多 N 个搜索同时跑，超出排队
 */

const MAX_CONCURRENT_SEARCHES = 4;
const MAX_QUEUE_SIZE = 100;
const QUEUE_TIMEOUT_MS = 20_000;

// —— 层 1：并发限流 ——

interface QueueItem {
  resolve: () => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

let activeCount = 0;
const queue: QueueItem[] = [];

function tryDequeue(): void {
  while (queue.length > 0 && activeCount < MAX_CONCURRENT_SEARCHES) {
    const item = queue.shift()!;
    clearTimeout(item.timer);
    activeCount++;
    item.resolve();
  }
}

export function acquireSearchSlot(): Promise<() => void> {
  const release = () => {
    activeCount--;
    tryDequeue();
  };

  if (activeCount < MAX_CONCURRENT_SEARCHES) {
    activeCount++;
    return Promise.resolve(release);
  }

  if (queue.length >= MAX_QUEUE_SIZE) {
    console.warn(`[SearchLimiter] Queue full! Active: ${activeCount}, Queued: ${queue.length}`);
    return Promise.reject(
      new Error("搜索服务繁忙，请稍后重试")
    );
  }

  return new Promise<() => void>((resolve, reject) => {
    const timer = setTimeout(() => {
      const idx = queue.findIndex(
        (item) => item.resolve === wrappedResolve
      );
      if (idx !== -1) queue.splice(idx, 1);
      reject(new Error("搜索排队超时，请稍后重试"));
    }, QUEUE_TIMEOUT_MS);

    const wrappedResolve = () => resolve(release);
    queue.push({ resolve: wrappedResolve, reject, timer });
  });
}

// —— 层 2：Inflight 请求去重 ——

const inflightMap = new Map<string, Promise<any>>();

/**
 * 对相同关键词的搜索做去重：
 * - 第一个请求正常执行
 * - 后续相同关键词的请求直接等待第一个的结果
 * - 几百人同时搜同一个词 → 只执行 1 次爬取
 */
export async function deduplicatedSearch<T>(
  cacheKey: string,
  searchFn: () => Promise<T>
): Promise<T> {
  const existing = inflightMap.get(cacheKey);
  if (existing) {
    return existing as Promise<T>;
  }

  const promise = searchFn().finally(() => {
    inflightMap.delete(cacheKey);
  });

  inflightMap.set(cacheKey, promise);
  return promise;
}

/** 获取当前限流器状态（用于监控） */
export function getSearchLimiterStats() {
  return {
    active: activeCount,
    queued: queue.length,
    inflight: inflightMap.size,
    maxConcurrent: MAX_CONCURRENT_SEARCHES,
    maxQueue: MAX_QUEUE_SIZE,
  };
}
