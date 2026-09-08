import { DEFAULT_BASE_URL, parseBookUrl } from "./urls.ts";

export interface SitemapBookEntry {
  sourceId: number;
  loc: string;
  slug: string;
  lastmod: string | null;
}

export function sitemapIndexUrl(base = DEFAULT_BASE_URL): string {
  return `${base.replace(/\/+$/, "")}/sitemap/`;
}

export function parseSitemapIndex(xml: string): string[] {
  const urls: string[] = [];
  const re = /<loc>\s*([^<]+)\s*<\/loc>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml))) {
    urls.push(match[1]!.trim());
  }
  return urls;
}

export function isArticleSitemapUrl(url: string): boolean {
  return /sitemap/i.test(url) && !/category|tag|static|author|performer/i.test(url);
}

/**
 * Best-effort book URL extraction from a sitemap body.
 * akniga book URLs are slug paths; sourceId is unknown until the detail page is fetched,
 * so entries without a numeric id are skipped here (subscriptions discover books instead).
 */
export function parseBookSitemap(xml: string, base = DEFAULT_BASE_URL): SitemapBookEntry[] {
  const entries: SitemapBookEntry[] = [];
  const blocks = xml.split(/<url>/i).slice(1);
  for (const block of blocks) {
    const loc = /<loc>\s*([^<]+)\s*<\/loc>/i.exec(block)?.[1]?.trim();
    if (!loc) continue;
    const ref = parseBookUrl(loc, base);
    if (!ref) continue;
    // Without a numeric id we cannot key the books table; skip bare slugs.
    if (!ref.sourceId) continue;
    const lastmod = /<lastmod>\s*([^<]+)\s*<\/lastmod>/i.exec(block)?.[1]?.trim() ?? null;
    entries.push({ sourceId: ref.sourceId, loc: ref.url, slug: ref.slug, lastmod });
  }
  return entries;
}
