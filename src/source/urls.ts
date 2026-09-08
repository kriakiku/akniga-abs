export const DEFAULT_BASE_URL = "https://akniga.org";

/** Paths that are site features, not book slugs. */
const RESERVED_SEGMENTS = new Set([
  "authors",
  "author",
  "performers",
  "performer",
  "sections",
  "section",
  "series",
  "search",
  "label",
  "ajax",
  "api",
  "paid",
  "page",
  "comments",
  "uploads",
  "application",
  "rss",
  "feed",
  "stream",
  "subscribe",
  "downloads",
  "collections",
  "collection",
  "sitemap",
  "admin",
  "profile",
  "login",
  "index",
  "random",
  "updated",
  "studio",
  "partner",
  "blog",
  "blogs",
  "talk",
  "wall",
  "history",
  "content",
  "rest",
  "chat",
]);

export function absoluteUrl(href: string | undefined, base = DEFAULT_BASE_URL): string | null {
  if (!href) return null;
  try {
    return new URL(href, `${base}/`).toString();
  } catch {
    return null;
  }
}

export function normaliseKey(raw: string): string {
  try {
    return decodeURIComponent(raw.replace(/\+/g, " ")).trim();
  } catch {
    return raw.trim();
  }
}

export interface BookRef {
  sourceId: number;
  slug: string;
  url: string;
}

/**
 * Book URLs are `/<slug>` with a numeric id carried in `data-bid` on the page.
 * When only a slug URL is known, sourceId may be 0 until the detail page is fetched.
 */
export function parseBookUrl(href: string | undefined, base = DEFAULT_BASE_URL): BookRef | null {
  const url = absoluteUrl(href, base);
  if (!url) return null;
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return null;
  }
  const segments = path.split("/").filter(Boolean);
  if (segments.length !== 1) return null;
  const slug = segments[0]!;
  if (slug.includes(".") && !/^[a-z0-9][\w.-]*$/i.test(slug)) return null;
  if (RESERVED_SEGMENTS.has(slug.toLowerCase())) return null;
  if (!/^[a-z0-9][\w.-]*$/i.test(slug)) return null;
  return { sourceId: 0, slug, url: `${base.replace(/\/+$/, "")}/${slug}` };
}

export function bookUrl(slug: string, base = DEFAULT_BASE_URL): string {
  return `${base.replace(/\/+$/, "")}/${slug.replace(/^\/+/, "")}`;
}

export function parseAuthorKey(href: string | undefined, base = DEFAULT_BASE_URL): string | null {
  return parsePrefixedKey(href, "/author/", base);
}

export function parsePerformerKey(href: string | undefined, base = DEFAULT_BASE_URL): string | null {
  return parsePrefixedKey(href, "/performer/", base);
}

export function parseSeriesKey(href: string | undefined, base = DEFAULT_BASE_URL): string | null {
  return parsePrefixedKey(href, "/series/", base);
}

export function parseSectionKey(href: string | undefined, base = DEFAULT_BASE_URL): string | null {
  return parsePrefixedKey(href, "/section/", base);
}

export function parseLabelKey(href: string | undefined, base = DEFAULT_BASE_URL): string | null {
  const url = absoluteUrl(href, base);
  if (!url) return null;
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return null;
  }
  if (!path.startsWith("/label/")) return null;
  const raw = path.slice("/label/".length).replace(/\/+$/, "");
  return raw ? normaliseKey(raw) : null;
}

function parsePrefixedKey(href: string | undefined, prefix: string, base: string): string | null {
  const url = absoluteUrl(href, base);
  if (!url) return null;
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return null;
  }
  if (!path.startsWith(prefix)) return null;
  const raw = path.slice(prefix.length).replace(/\/+$/, "");
  if (!raw) return null;
  return normaliseKey(raw);
}

export function authorUrl(name: string, base = DEFAULT_BASE_URL): string {
  return `${base.replace(/\/+$/, "")}/author/${encodeURIComponent(name)}/`;
}

export function performerUrl(name: string, base = DEFAULT_BASE_URL): string {
  return `${base.replace(/\/+$/, "")}/performer/${encodeURIComponent(name)}/`;
}

export function seriesUrl(name: string, base = DEFAULT_BASE_URL): string {
  return `${base.replace(/\/+$/, "")}/series/${encodeURIComponent(name)}/`;
}

export function sectionUrl(key: string, base = DEFAULT_BASE_URL): string {
  return `${base.replace(/\/+$/, "")}/section/${encodeURIComponent(key)}/`;
}

export function searchBooksUrl(query: string, page = 1, base = DEFAULT_BASE_URL): string {
  const root = base.replace(/\/+$/, "");
  const q = encodeURIComponent(query);
  if (page <= 1) return `${root}/search/books/?q=${q}`;
  return `${root}/search/books/page${page}/?q=${q}`;
}

/** Duration like `12:34:56`, `1:02:03`, or `45:00`. */
export function parseDurationToSeconds(raw: string | undefined | null): number | null {
  if (!raw) return null;
  const text = raw.trim();
  const match = /^(\d+):(\d{1,2})(?::(\d{1,2}))?$/.exec(text);
  if (!match) {
    const asNumber = Number.parseInt(text, 10);
    return Number.isFinite(asNumber) && asNumber > 0 ? asNumber : null;
  }
  const a = Number.parseInt(match[1]!, 10);
  const b = Number.parseInt(match[2]!, 10);
  const c = match[3] !== undefined ? Number.parseInt(match[3], 10) : null;
  if (c === null) return a * 60 + b;
  return a * 3600 + b * 60 + c;
}

/** Pull trailing `(N)` volume number from series link text. */
export function parseSeriesSequence(label: string): { name: string; sequence: string | null } {
  const trimmed = label.replace(/\s+/g, " ").trim();
  const match = /^(.*?)\s*\((\d+)\)\s*$/.exec(trimmed);
  if (!match) return { name: trimmed, sequence: null };
  return { name: match[1]!.trim(), sequence: match[2]! };
}
