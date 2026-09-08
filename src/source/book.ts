import * as cheerio from "cheerio";
import type { CheerioAPI } from "cheerio";
import { htmlToText, stripNoiseLines } from "./html.ts";
import {
  DEFAULT_BASE_URL,
  absoluteUrl,
  parseAuthorKey,
  parseBookUrl,
  parseDurationToSeconds,
  parseLabelKey,
  parsePerformerKey,
  parseSectionKey,
  parseSeriesKey,
  parseSeriesSequence,
} from "./urls.ts";

export interface NamedRef {
  key: string;
  name: string;
}

export interface ParsedBook {
  sourceId: number;
  url: string;
  slug: string;
  title: string;
  description: string | null;
  coverUrl: string | null;
  durationSec: number | null;
  rating: number | null;
  votes: number | null;
  authors: NamedRef[];
  narrators: NamedRef[];
  genres: NamedRef[];
  series: (NamedRef & { sequence: string | null }) | null;
  tags: string[];
  /** Sibling books linked from series / related blocks. */
  relatedBookIds: number[];
  /** Paid / subscription-only book — must not be downloaded. */
  isPaid: boolean;
}

function metaContent($: CheerioAPI, selectors: string[]): string | undefined {
  for (const selector of selectors) {
    const value = $(selector).attr("content");
    if (value && value.trim()) return value.trim();
  }
  return undefined;
}

function uniqueByKey(refs: NamedRef[]): NamedRef[] {
  const seen = new Map<string, NamedRef>();
  for (const ref of refs) {
    if (!ref.key || !ref.name) continue;
    if (!seen.has(ref.key)) seen.set(ref.key, ref);
  }
  return [...seen.values()];
}

/** Free books advertise «бесплатно» in the document title; paid ones do not. */
export function isPaidBookPage(html: string, titleHint?: string): boolean {
  const $ = cheerio.load(html);
  const title =
    titleHint ??
    metaContent($, ['meta[property="og:title"]']) ??
    $("title").first().text() ??
    "";
  if (/бесплатно/i.test(title)) return false;
  // Explicit paid markers on the book article.
  if ($(".book--item--closed, .js-topic-comments-biblio--locked").length > 0) return true;
  // No chapter list with titles usually means preview / paywalled player.
  const chapters = $(".bookpage--chapters .chapter__default--title")
    .toArray()
    .map((el) => $(el).text().trim())
    .filter(Boolean);
  if (chapters.length === 0 && /слушать онлайн/i.test(title) && !/бесплатно/i.test(title)) {
    return true;
  }
  return !/бесплатно/i.test(title);
}

function extractTitle($: CheerioAPI): string {
  const siteName = metaContent($, ['meta[property="og:site_name"]']);
  const ogTitle = metaContent($, ['meta[property="og:title"]', 'meta[property="twitter:title"]']);
  if (ogTitle) {
    let title = ogTitle;
    if (siteName && title.includes(siteName)) {
      title = title.replace(/\s*[—\-–]\s*.*$/, "").trim();
    }
    title = title
      .replace(/\s*[—\-–]\s*слушать аудиокнигу.*$/i, "")
      .replace(/\s*\([^)]*\)\s*$/, (m) => {
        // Keep series markers in title if they look like part of the work name;
        // strip trailing "(Author)" only when it matches an author link later.
        return m;
      })
      .trim();
    // Prefer "Title (Author)" → drop author parenthetical when it matches known pattern from og.
    const authorParen = /^(.*?)\s+\(([^)]+)\)\s*$/.exec(title);
    if (authorParen) {
      const maybeAuthor = authorParen[2]!;
      const hasAuthorLink = $(`a[href*="/author/"]`).toArray().some((el) => {
        return $(el).text().replace(/\s+/g, " ").trim() === maybeAuthor;
      });
      if (hasAuthorLink) title = authorParen[1]!.trim();
    }
    if (title) return title;
  }
  const h1 = $("h1").first().text().replace(/\s+/g, " ").trim();
  return h1;
}

function extractDescription($: CheerioAPI): string | null {
  const container = $(".description__article-main, [itemprop='description']").first();
  if (container.length === 0) return null;
  const clone = container.clone();
  clone.find("script, style, .quote, iframe").remove();
  const text = stripNoiseLines(htmlToText($, clone.get(0)));
  return text.length > 0 ? text.replace(/^Описание\s*/i, "").trim() || null : null;
}

function extractDurationSec($: CheerioAPI): number | null {
  const fromMeta = parseDurationToSeconds(metaContent($, ['meta[itemprop="duration"]']));
  if (fromMeta) return fromMeta;
  // Chapter last end time is a good fallback when available after JS — HTML often has per-chapter times.
  let max = 0;
  $(".bookpage--chapters .chapter__default--time").each((_, el) => {
    const text = $(el).text().replace(/\s+/g, " ").trim();
    const cleaned = text.replace(/.*\//, "").trim();
    const sec = parseDurationToSeconds(cleaned);
    if (sec && sec > max) max = sec;
  });
  return max > 0 ? max : null;
}

/**
 * Parse an akniga book page. Returns null when the page is not a book (404 / error shell).
 */
export function parseBookPage(html: string, pageUrl: string, base = DEFAULT_BASE_URL): ParsedBook | null {
  const $ = cheerio.load(html);

  if ($(".book--page, .js-topic[data-bid], article.book--page").length === 0 && $("[data-bid]").length === 0) {
    // Error pages still have the global player chrome but no book article.
    if (/Ошибка/i.test($("title").text()) || /ошибка/i.test(metaContent($, ['meta[property="og:title"]']) ?? "")) {
      return null;
    }
  }

  const bidRaw =
    $("[data-bid]").first().attr("data-bid") ??
    $(".book--player[class*='book-id-']")
      .attr("class")
      ?.match(/book-id-(\d+)/)?.[1] ??
    null;
  const sourceId = bidRaw ? Number.parseInt(bidRaw, 10) : Number.NaN;
  if (!Number.isFinite(sourceId) || sourceId <= 0) return null;

  const canonical =
    absoluteUrl($('link[rel="canonical"]').attr("href"), base) ??
    metaContent($, ['meta[property="og:url"]']) ??
    pageUrl;
  const ref = parseBookUrl(canonical, base) ?? parseBookUrl(pageUrl, base);
  const slug = ref?.slug ?? canonical.split("/").filter(Boolean).pop() ?? String(sourceId);
  const url = ref?.url ?? `${base.replace(/\/+$/, "")}/${slug}`;

  const title = extractTitle($);
  if (!title) return null;

  const authors: NamedRef[] = [];
  $('a[href*="/author/"]').each((_, element) => {
    const anchor = $(element);
    const key = parseAuthorKey(anchor.attr("href"), base);
    const name = anchor.text().replace(/\s+/g, " ").trim();
    if (key && name) authors.push({ key, name });
  });

  const narrators: NamedRef[] = [];
  $('a[href*="/performer/"], a[rel="performer"]').each((_, element) => {
    const anchor = $(element);
    const key = parsePerformerKey(anchor.attr("href"), base);
    const name = anchor.text().replace(/\s+/g, " ").trim();
    if (key && name) narrators.push({ key, name });
  });

  const genres: NamedRef[] = [];
  $('a.section__title[href*="/section/"], a[href*="/section/"]').each((_, element) => {
    const anchor = $(element);
    const key = parseSectionKey(anchor.attr("href"), base);
    const name = anchor.text().replace(/\s+/g, " ").trim();
    if (key && name) genres.push({ key, name });
  });

  let series: (NamedRef & { sequence: string | null }) | null = null;
  $('a.link__series[href*="/series/"], a[href*="/series/"]').each((_, element) => {
    if (series) return;
    const anchor = $(element);
    const key = parseSeriesKey(anchor.attr("href"), base);
    const rawName = anchor.text().replace(/\s+/g, " ").trim();
    if (!key || !rawName) return;
    const { name, sequence } = parseSeriesSequence(rawName);
    series = { key, name, sequence };
  });

  const tags = new Set<string>();
  $('a[href*="/label/"]').each((_, element) => {
    const anchor = $(element);
    const key = parseLabelKey(anchor.attr("href"), base);
    const name = anchor.text().replace(/\s+/g, " ").trim();
    if (name) tags.add(name);
    else if (key) tags.add(key);
  });

  const relatedBookIds = new Set<number>();
  // Series listing links on the page may carry data-bid.
  $("[data-bid]").each((_, element) => {
    const id = Number.parseInt($(element).attr("data-bid") ?? "", 10);
    if (Number.isFinite(id) && id > 0 && id !== sourceId) relatedBookIds.add(id);
  });

  const votesRaw = $("[data-vote-num-id], .js-vote-topic").first().text().trim();
  const votes = votesRaw ? Number.parseInt(votesRaw.replace(/\D+/g, ""), 10) : Number.NaN;

  const documentTitle =
    metaContent($, ['meta[property="og:title"]']) ?? $("title").first().text() ?? title;
  const paid = isPaidBookPage(html, documentTitle);

  return {
    sourceId,
    url,
    slug,
    title,
    description: extractDescription($),
    coverUrl: absoluteUrl(metaContent($, ['meta[property="og:image"]', 'meta[property="twitter:image"]']), base),
    durationSec: extractDurationSec($),
    rating: null,
    votes: Number.isFinite(votes) ? votes : null,
    authors: uniqueByKey(authors),
    narrators: uniqueByKey(narrators),
    genres: uniqueByKey(genres),
    series,
    tags: [...tags],
    relatedBookIds: [...relatedBookIds],
    isPaid: paid,
  };
}

/** Chapter titles + start offsets from the static HTML chapter list (when present). */
export function parseChapterListFromHtml(html: string): Array<{ id: number; title: string; startSec: number | null }> {
  const $ = cheerio.load(html);
  const chapters: Array<{ id: number; title: string; startSec: number | null }> = [];
  $(".bookpage--chapters .chapter__default[data-id]").each((_, element) => {
    const el = $(element);
    const id = Number.parseInt(el.attr("data-id") ?? "", 10);
    const title = el.find(".chapter__default--title").first().text().replace(/\s+/g, " ").trim();
    const pos = el.attr("data-pos");
    const startSec = pos !== undefined ? Number.parseInt(pos, 10) : Number.NaN;
    if (!title) return;
    chapters.push({
      id: Number.isFinite(id) ? id : chapters.length,
      title,
      startSec: Number.isFinite(startSec) ? startSec : null,
    });
  });
  return chapters;
}
