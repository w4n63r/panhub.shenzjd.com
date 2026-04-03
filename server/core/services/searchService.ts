import pLimit from "p-limit";
import { UnifiedCache, CacheNamespace } from "../cache/unifiedCache";
import { safeExecute } from "../utils/fetch";
import type { MergedLinks, SearchResponse, SearchResult } from "../types/models";
import { PluginManager, type AsyncSearchPlugin } from "../plugins/manager";
import {
  PluginHealthChecker,
  createPluginHealthChecker,
} from "../plugins/pluginHealth";
import {
  ErrorCollector,
  classifyError,
  type WarningInfo,
} from "../utils/errors";
import { buildSearchKeywordVariants } from "../utils/searchKeyword";

export interface SearchServiceOptions {
  priorityChannels: string[];
  defaultChannels: string[];
  defaultConcurrency: number;
  pluginTimeoutMs: number;
  cacheEnabled: boolean;
  cacheTtlMinutes: number;
}

export class SearchService {
  private static readonly TG_CHANNEL_LIMIT = 40;
  private static readonly TG_DEEP_CHANNEL_LIMIT = 80;
  private static readonly TG_DEEP_SEARCH_TRIGGER = 3;
  private static readonly PLUGIN_VARIANT_TRIGGER = 5;
  private static readonly MAX_TG_CONCURRENCY = 3;
  private static readonly MAX_PLUGIN_CONCURRENCY = 3;

  private options: SearchServiceOptions;
  private pluginManager: PluginManager;
  private cache: UnifiedCache;
  private healthChecker: PluginHealthChecker;

  constructor(options: SearchServiceOptions, pluginManager: PluginManager) {
    this.options = options;
    this.pluginManager = pluginManager;
    this.cache = new UnifiedCache(
      {
        enabled: options.cacheEnabled,
        ttlMinutes: options.cacheTtlMinutes,
      },
      "search"
    );

    this.healthChecker = createPluginHealthChecker();
  }

  getPluginManager() {
    return this.pluginManager;
  }

  async search(
    keyword: string,
    channels: string[] | undefined,
    concurrency: number | undefined,
    forceRefresh: boolean | undefined,
    resultType: string | undefined,
    sourceType: "all" | "tg" | "plugin" | undefined,
    plugins: string[] | undefined,
    cloudTypes: string[] | undefined,
    ext: Record<string, any> | undefined
  ): Promise<SearchResponse> {
    const { response } = await this.searchWithWarnings(
      keyword,
      channels,
      concurrency,
      forceRefresh,
      resultType,
      sourceType,
      plugins,
      cloudTypes,
      ext
    );

    return response;
  }

  async searchWithWarnings(
    keyword: string,
    channels: string[] | undefined,
    concurrency: number | undefined,
    forceRefresh: boolean | undefined,
    resultType: string | undefined,
    sourceType: "all" | "tg" | "plugin" | undefined,
    plugins: string[] | undefined,
    cloudTypes: string[] | undefined,
    ext: Record<string, any> | undefined
  ): Promise<{ response: SearchResponse; warnings: WarningInfo[] }> {
    const errorCollector = new ErrorCollector();
    const effChannels =
      channels && channels.length > 0 ? channels : this.options.defaultChannels;
    const effConcurrency =
      concurrency && concurrency > 0
        ? concurrency
        : this.options.defaultConcurrency;
    const effResultType =
      !resultType || resultType === "merge" ? "merged_by_type" : resultType;
    const effSourceType = sourceType ?? "plugin";

    let tgResults: SearchResult[] = [];
    let pluginResults: SearchResult[] = [];

    const tasks: Array<() => Promise<void>> = [];

    // TG 搜索任务 (当前已禁用，仅在显式指定 src=tg 时可用)
    if (effSourceType === "tg") {
      tasks.push(async () => {
        const concOverride =
          typeof concurrency === "number" && concurrency > 0
            ? concurrency
            : undefined;
        tgResults = await this.searchTG(
          keyword,
          effChannels,
          !!forceRefresh,
          concOverride,
          ext
        );
      });
    }
    if (effSourceType === "all" || effSourceType === "plugin") {
      tasks.push(async () => {
        pluginResults = await this.searchPlugins(
          keyword,
          plugins,
          !!forceRefresh,
          effConcurrency,
          ext ?? {},
          errorCollector
        );
      });
    }

    await Promise.all(tasks.map((task) => task()));

    const allResults = this.mergeSearchResults(tgResults, pluginResults);
    this.sortResultsByTimeDesc(allResults);

    const filteredForResults: SearchResult[] = [];
    for (const result of allResults) {
      const hasTime = !!result.datetime;
      const hasLinks = Array.isArray(result.links) && result.links.length > 0;
      const keywordPriority = this.getKeywordPriority(result.title);
      const pluginLevel = this.getPluginLevelBySource(
        this.getResultSource(result)
      );
      if (hasTime || hasLinks || keywordPriority > 0 || pluginLevel <= 2) {
        filteredForResults.push(result);
      }
    }

    const mergedLinks = this.mergeResultsByType(
      allResults,
      keyword,
      cloudTypes
    );

    let total = 0;
    let response: SearchResponse = { total: 0 };
    if (effResultType === "merged_by_type") {
      total = Object.values(mergedLinks).reduce(
        (sum, items) => sum + items.length,
        0
      );
      response = { total, merged_by_type: mergedLinks };
    } else if (effResultType === "results") {
      total = filteredForResults.length;
      response = { total, results: filteredForResults };
    } else {
      total = filteredForResults.length;
      response = {
        total,
        results: filteredForResults,
        merged_by_type: mergedLinks,
      };
    }

    return {
      response,
      warnings: errorCollector.getWarnings(),
    };
  }

  private async searchTG(
    keyword: string,
    channels: string[] | undefined,
    forceRefresh: boolean,
    concurrencyOverride?: number,
    ext?: Record<string, any>
  ): Promise<SearchResult[]> {
    const chList = Array.isArray(channels) ? channels : [];
    const cacheKey = `tg:${keyword}:${[...chList].sort().join(",")}`;
    const { cacheEnabled, priorityChannels } = this.options;

    if (!forceRefresh && cacheEnabled) {
      const cached = this.cache.get(CacheNamespace.TG_SEARCH, cacheKey);
      if (cached.hit && cached.value) {
        return cached.value;
      }
    }

    const { fetchTgChannelPosts } = await import("./tg");
    const requestedTimeout = Number((ext as any)?.__plugin_timeout_ms) || 0;
    const timeoutMs = Math.max(
      3000,
      requestedTimeout > 0
        ? requestedTimeout
        : this.options.pluginTimeoutMs || 0
    );
    const concurrency = Math.max(
      2,
      Math.min(
        concurrencyOverride ?? this.options.defaultConcurrency,
        SearchService.MAX_TG_CONCURRENCY
      )
    );

    const prioritySet = new Set(priorityChannels || []);
    const priorityList = chList.filter((channel) => prioritySet.has(channel));
    const normalList = chList.filter((channel) => !prioritySet.has(channel));

    const createChannelTask =
      (channel: string, limitPerChannel: number) => async () => {
        const result = await safeExecute(
          () =>
            this.withTimeout<SearchResult[]>(
              fetchTgChannelPosts(channel, keyword, {
                limitPerChannel,
              }),
              timeoutMs,
              []
            ),
          []
        );
        return result;
      };

    const flattenResults = (items: SearchResult[][]) => {
      const flattened: SearchResult[] = [];
      for (const arr of items) {
        if (Array.isArray(arr)) {
          flattened.push(...arr);
        }
      }
      return flattened;
    };

    const shallowTasks = [...priorityList, ...normalList].map((channel) =>
      createChannelTask(channel, SearchService.TG_CHANNEL_LIMIT)
    );
    const shallowResults = flattenResults(
      await this.runWithConcurrency(shallowTasks, concurrency)
    );

    let results = shallowResults;
    // 深度搜索：仅对 priority 频道重试，避免全量翻倍
    if (
      results.length < SearchService.TG_DEEP_SEARCH_TRIGGER &&
      keyword.trim().length > 1 &&
      priorityList.length > 0
    ) {
      const deepTasks = priorityList.map((channel) =>
        createChannelTask(channel, SearchService.TG_DEEP_CHANNEL_LIMIT)
      );
      const deepResults = flattenResults(
        await this.runWithConcurrency(deepTasks, concurrency)
      );
      results = this.mergeUniqueResults(results, deepResults);
    }

    if (cacheEnabled && results.length > 0) {
      this.cache.set(CacheNamespace.TG_SEARCH, cacheKey, results);
    }

    return results;
  }

  private async searchPlugins(
    keyword: string,
    plugins: string[] | undefined,
    forceRefresh: boolean,
    concurrency: number,
    ext: Record<string, any>,
    errorCollector: ErrorCollector
  ): Promise<SearchResult[]> {
    const cacheKey = `plugin:${keyword}:${(plugins ?? [])
      .map((plugin) => plugin?.toLowerCase())
      .filter(Boolean)
      .sort()
      .join(",")}`;
    const { cacheEnabled } = this.options;

    if (!forceRefresh && cacheEnabled) {
      const cached = this.cache.get(CacheNamespace.PLUGIN_SEARCH, cacheKey);
      if (cached.hit && cached.value) {
        return cached.value;
      }
    }

    const allPlugins = this.pluginManager.getPlugins();
    const healthyPlugins = allPlugins.filter((plugin) =>
      this.healthChecker.isHealthy(plugin.name())
    );

    let available: AsyncSearchPlugin[] = [];
    if (plugins && plugins.length > 0 && plugins.some((plugin) => !!plugin)) {
      const wanted = new Set(plugins.map((plugin) => plugin.toLowerCase()));
      available = healthyPlugins.filter((plugin) =>
        wanted.has(plugin.name().toLowerCase())
      );
    } else {
      available = healthyPlugins;
    }

    const requestedTimeout = Number((ext as any)?.__plugin_timeout_ms) || 0;
    const timeoutMs = Math.max(
      3000,
      requestedTimeout > 0
        ? requestedTimeout
        : this.options.pluginTimeoutMs || 0
    );

    const pluginPromises = available.map((plugin) => async () => {
      plugin.setMainCacheKey(cacheKey);
      plugin.setCurrentKeyword(keyword);

      const startTime = Date.now();
      const pluginName = plugin.name();
      const queries =
        (keyword || "").trim().length <= 1
          ? [keyword, "电影", "movie", "1080p"]
          : buildSearchKeywordVariants(keyword).slice(0, 3);

      let results: SearchResult[] = [];
      for (const [index, query] of queries.entries()) {
        const currentResults = await this.withTimeout<SearchResult[]>(
          plugin.search(query, ext),
          timeoutMs,
          []
        );

        results = this.mergeUniqueResults(results, currentResults || []);

        if (
          results.length >= SearchService.PLUGIN_VARIANT_TRIGGER ||
          index === queries.length - 1
        ) {
          break;
        }
      }

      const responseTime = Date.now() - startTime;
      this.healthChecker.recordSuccess(pluginName, responseTime);

      return results;
    });

    const pluginConcurrency = Math.min(
      concurrency,
      SearchService.MAX_PLUGIN_CONCURRENCY
    );
    const resultsByPlugin = await this.runWithConcurrency(
      pluginPromises.map((promiseFactory) => async () => {
        try {
          return await promiseFactory();
        } catch (error) {
          const errorDetail = classifyError(error, "plugin_search");
          errorCollector.record(errorDetail);
          return [];
        }
      }),
      pluginConcurrency
    );

    const merged: SearchResult[] = [];
    for (const arr of resultsByPlugin) {
      if (Array.isArray(arr)) {
        merged.push(...arr);
      }
    }

    if (cacheEnabled && merged.length > 0) {
      this.cache.set(CacheNamespace.PLUGIN_SEARCH, cacheKey, merged);
    }

    return merged;
  }

  private withTimeout<T>(
    promise: Promise<T>,
    ms: number,
    fallback: T
  ): Promise<T> {
    if (!ms || ms <= 0) return promise;
    let timeoutHandle: any;
    const timeoutPromise = new Promise<T>((resolve) => {
      timeoutHandle = setTimeout(() => resolve(fallback), ms);
    });
    return Promise.race([
      promise.finally(() => clearTimeout(timeoutHandle)),
      timeoutPromise,
    ]) as Promise<T>;
  }

  private mergeSearchResults(
    a: SearchResult[],
    b: SearchResult[]
  ): SearchResult[] {
    return this.mergeUniqueResults(a, b);
  }

  private mergeUniqueResults(
    a: SearchResult[],
    b: SearchResult[]
  ): SearchResult[] {
    const seen = new Set<string>();
    const out: SearchResult[] = [];
    const pushUnique = (result: SearchResult) => {
      const firstLink = Array.isArray(result.links) ? result.links[0]?.url : "";
      const key =
        result.unique_id ||
        result.message_id ||
        firstLink ||
        `${result.title}|${result.channel}|${result.datetime || ""}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push(result);
    };

    for (const result of a) pushUnique(result);
    for (const result of b) pushUnique(result);
    return out;
  }

  private sortResultsByTimeDesc(arr: SearchResult[]) {
    arr.sort(
      (x, y) => new Date(y.datetime).getTime() - new Date(x.datetime).getTime()
    );
  }

  private getResultSource(_r: SearchResult): string {
    return "";
  }

  private getPluginLevelBySource(_source: string): number {
    return 3;
  }

  private getKeywordPriority(_title: string): number {
    return 0;
  }

  private mergeResultsByType(
    results: SearchResult[],
    _keyword: string,
    cloudTypes?: string[]
  ): MergedLinks {
    const allow =
      cloudTypes && cloudTypes.length > 0
        ? new Set(cloudTypes.map((value) => value.toLowerCase()))
        : undefined;
    const out: MergedLinks = {};
    for (const result of results) {
      for (const link of result.links || []) {
        const type = (link.type || "").toLowerCase();
        if (allow && !allow.has(type)) continue;
        if (!out[type]) out[type] = [];
        out[type].push({
          url: link.url,
          password: link.password,
          note: result.title,
          datetime: result.datetime,
          images: result.images,
        });
      }
    }
    return out;
  }

  private async runWithConcurrency<T>(
    tasks: Array<() => Promise<T>>,
    limit: number
  ): Promise<T[]> {
    const limitFn = pLimit(limit);
    const limitedTasks = tasks.map((task) => limitFn(task));
    return Promise.all(limitedTasks);
  }

  getCacheStats() {
    return this.cache.getStats();
  }

  clearCache(namespace?: CacheNamespace) {
    if (namespace) {
      this.cache.clearNamespace(namespace);
    } else {
      this.cache.clearAll();
    }
  }

  getPluginHealthStatus() {
    return this.healthChecker.getAllStatus();
  }

  resetPluginHealth(pluginName?: string) {
    if (pluginName) {
      this.healthChecker.reset(pluginName);
    } else {
      this.healthChecker.resetAll();
    }
  }
}
