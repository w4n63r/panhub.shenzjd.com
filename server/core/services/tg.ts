import { load } from "cheerio";
import { ofetch } from "ofetch";
import type { SearchResult } from "../types/models";
import {
  matchesSearchKeyword,
  buildSearchKeywordVariants,
  normalizeSearchKeyword,
} from "../utils/searchKeyword";

export interface TgFetchOptions {
  limitPerChannel?: number;
  userAgent?: string;
}

/** Precomputed keyword data to avoid recomputation per message */
interface PrecomputedKeyword {
  raw: string;
  normalizedVariants: string[];
}

function precomputeKeyword(keyword: string): PrecomputedKeyword {
  const variants = buildSearchKeywordVariants(keyword);
  return {
    raw: keyword,
    normalizedVariants: variants.map((v) => normalizeSearchKeyword(v)),
  };
}

function matchesPrecomputed(
  text: string,
  precomputed: PrecomputedKeyword
): boolean {
  if (!precomputed.raw.trim()) return true;
  const source = (text || "").trim();
  if (!source) return false;
  const normalizedSource = normalizeSearchKeyword(source);
  if (!normalizedSource) return false;
  return precomputed.normalizedVariants.some((nv) =>
    normalizedSource.includes(nv)
  );
}

export async function fetchTgChannelPosts(
  channel: string,
  keyword: string,
  options: TgFetchOptions = {}
): Promise<SearchResult[]> {
  const ua =
    options.userAgent ||
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

  const limit = options.limitPerChannel ?? 50;
  const maxPages = Math.ceil(limit / 20);
  const allResults: SearchResult[] = [];
  let before: string | undefined;
  const precomputed = precomputeKeyword(keyword);

  for (let page = 0; page < maxPages && allResults.length < limit; page++) {
    const baseUrl = `https://t.me/s/${encodeURIComponent(channel)}`;
    const url = before ? `${baseUrl}?before=${before}` : baseUrl;

    let html = "";
    try {
      html = await ofetch<string>(url, { headers: { "user-agent": ua } });
    } catch {}

    if (!html || !html.includes("tgme_widget_message")) {
      const mirrorUrl = before
        ? `https://r.jina.ai/https://t.me/s/${encodeURIComponent(channel)}?before=${before}`
        : `https://r.jina.ai/https://t.me/s/${encodeURIComponent(channel)}`;

      try {
        html = await ofetch<string>(mirrorUrl, { headers: { "user-agent": ua } });
      } catch {}
    }

    if (!html || !html.includes("tgme_widget_message")) {
      break;
    }

    const $ = load(html || "");
    const pageResults = parseChannelPage(
      $,
      channel,
      precomputed,
      limit - allResults.length
    );
    allResults.push(...pageResults);

    const nextLink = $('a[href*="before="]').first();
    const href = nextLink.attr("href");
    if (href) {
      const match = href.match(/before=([^&]+)/);
      if (match) {
        before = match[1];
      } else {
        break;
      }
    } else {
      break;
    }

    if (page < maxPages - 1 && allResults.length < limit) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  return allResults;
}

function parseChannelPage(
  $: ReturnType<typeof load>,
  channel: string,
  precomputed: PrecomputedKeyword,
  limit: number
): SearchResult[] {
  const results: SearchResult[] = [];

  const deproxyUrl = (raw: string): string => {
    try {
      const u = new URL(raw);
      if (u.hostname === "r.jina.ai") {
        const path = decodeURIComponent(u.pathname || "");
        if (path.startsWith("/http://") || path.startsWith("/https://")) {
          return path.slice(1);
        }
      }
      return raw;
    } catch {
      return raw;
    }
  };

  const classifyByHostname = (hostname: string): string => {
    const host = hostname.toLowerCase();
    if (host === "t.me" || host.endsWith(".t.me")) return "";
    if (host === "r.jina.ai") return "";
    if (host.endsWith("alipan.com") || host.endsWith("aliyundrive.com")) return "aliyun";
    if (host === "pan.baidu.com") return "baidu";
    if (host === "pan.quark.cn") return "quark";
    if (host === "pan.xunlei.com") return "xunlei";
    if (host.endsWith("123pan.com")) return "123";
    if (host === "cloud.189.cn") return "tianyi";
    if (host === "115.com" || host.endsWith(".115.com")) return "115";
    if (host === "drive.uc.cn") return "uc";
    if (host === "yun.139.com") return "mobile";
    return "";
  };

  $(".tgme_widget_message_wrap").each((i: number, el: any) => {
    if (results.length >= limit) return false;
    const root = $(el);
    const text = root.find(".tgme_widget_message_text").text().trim();
    const dateTitle = root.find("time").attr("datetime") || "";
    const postId = root.find(".tgme_widget_message").attr("data-post") || "";
    const firstLine = text.split("\n")[0] || text.slice(0, 80);

    if (!matchesPrecomputed(text, precomputed)) {
      return;
    }

    const links: { type: string; url: string; password: string }[] = [];
    const seenUrls = new Set<string>();
    const urlPattern = /https?:\/\/[A-Za-z0-9\-._~:\/?#\[\]@!$&'()*+,;=%]+/g;
    const passwdPattern = /(?:提取码|密码|pwd|pass)[:：\s]*([a-zA-Z0-9]{3,6})/i;

    const addUrl = (raw: string) => {
      const deproxied = deproxyUrl(raw);
      let host = "";
      try {
        host = new URL(deproxied).hostname || "";
      } catch {
        return;
      }
      const type = classifyByHostname(host);
      if (!type) return;

      const key = deproxied.toLowerCase();
      if (seenUrls.has(key)) return;
      seenUrls.add(key);

      const m = text.match(passwdPattern);
      const password = m?.[1] ?? "";
      links.push({ type, url: deproxied, password });
    };

    const urlsFromText = text.match(urlPattern) || [];
    for (const u of urlsFromText) addUrl(u);

    root.find(".tgme_widget_message_text a[href]").each((_: number, a: any) => {
      const href = $(a).attr("href");
      if (href) addUrl(href);
    });

    let title = firstLine;
    for (const link of links) {
      const escaped = link.url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      title = title.replace(new RegExp(escaped, "g"), "");
    }
    title = title
      .replace(
        /(名称|描述|链接|大小|标签|夸克|UC|百度|阿里|迅雷|115|天翼|123|移动|提取码|密码|📧|📿|：|,|\.|\||-|\s)+/g,
        " "
      )
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80);
    if (!title) title = firstLine.slice(0, 80);

    let content = text;
    for (const link of links) {
      const escaped = link.url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      content = content.replace(new RegExp(escaped, "g"), "");
      if (link.password) {
        content = content.replace(
          new RegExp(`(?:提取码|密码|pwd|pass)[:：\\s]*${link.password}`, "gi"),
          ""
        );
      }
    }
    content = content
      .replace(/(夸克|UC|百度|阿里|迅雷|115|天翼|123|移动|：|,|\.|\||-)+/g, "")
      .replace(/\s+/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim();

    results.push({
      message_id: postId,
      unique_id: `tg-${channel}-${postId || i}`,
      channel,
      datetime: dateTitle ? new Date(dateTitle).toISOString() : "",
      title,
      content,
      links,
    });
  });

  return results;
}
