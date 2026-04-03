import { defineEventHandler, readBody, sendError, createError } from "h3";
import { requireSearchAuth } from "../utils/requireAuth";
import { getOrCreateSearchService } from "../core/services";
import { acquireSearchSlot, deduplicatedSearch } from "../core/utils/searchLimiter";
import type { GenericResponse, SearchRequest } from "../core/types/models";

export default defineEventHandler(async (event) => {
  requireSearchAuth(event);
  const config = useRuntimeConfig();
  const service = getOrCreateSearchService(config);
  const body = (await readBody<SearchRequest>(event)) || ({} as SearchRequest);

  const kw = (body.kw || "").trim();
  if (!kw) {
    return sendError(
      event,
      createError({ statusCode: 400, statusMessage: "kw is required" })
    );
  }

  const parseList = (val: any): string[] | undefined => {
    if (Array.isArray(val)) {
      return val.filter((s) => typeof s === "string" && s.trim());
    }
    if (typeof val === "string") {
      return val
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }
    return undefined;
  };

  body.channels = parseList((body as any).channels);
  body.plugins = parseList((body as any).plugins);
  body.cloud_types = parseList((body as any).cloud_types);

  if (!body.res || body.res === "merge") body.res = "merged_by_type";
  if (!body.src) body.src = "plugin";

  if (body.src === "tg") {
    body.plugins = undefined;
  } else if (body.src === "plugin") {
    // 允许前端传 channels 作为插件列表，增强对现有前端的兼容性
    if (!body.plugins && body.channels && body.channels.length > 0) {
      body.plugins = [...body.channels];
    }
    body.channels = undefined;
  }

  let release: (() => void) | undefined;
  try {
    release = await acquireSearchSlot();
  } catch (err: any) {
    return sendError(
      event,
      createError({ statusCode: 503, message: err?.message || "服务繁忙" })
    );
  }

  try {
    const cacheKey = JSON.stringify({
      kw,
      ch: body.channels,
      src: body.src,
      pl: body.plugins,
      ct: body.cloud_types,
      ext: body.ext
    });

    const { response: result, warnings } = await deduplicatedSearch(cacheKey, () =>
      service.searchWithWarnings(
        kw,
        body.channels,
        body.conc,
        !!body.refresh,
        body.res,
        body.src,
        body.plugins,
        body.cloud_types,
        body.ext || {}
      )
    );

    const resp: GenericResponse<typeof result> = {
      code: 0,
      message: warnings.length > 0 ? "partial_success" : "success",
      data: result,
    };

    if (warnings.length > 0) {
      (resp as any).warnings = warnings;
    }

    return resp;
  } finally {
    release?.();
  }
});
