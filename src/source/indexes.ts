import * as cheerio from "cheerio";
import { DEFAULT_BASE_URL, normaliseKey, parseAuthorKey, parsePerformerKey } from "./urls.ts";

export interface IndexEntry {
  key: string;
  name: string;
  bookCount: number | null;
}

/**
 * Parse `/authors/` or `/performers/` index pages (and their AJAX search result fragments).
 */
export function parseEntityIndex(
  html: string,
  kind: "author" | "performer",
  base = DEFAULT_BASE_URL,
): IndexEntry[] {
  const $ = cheerio.load(html);
  const out: IndexEntry[] = [];
  const seen = new Set<string>();

  const selector = kind === "author" ? 'a[href*="/author/"]' : 'a[href*="/performer/"]';
  $(selector).each((_, element) => {
    const anchor = $(element);
    const href = anchor.attr("href");
    const key = kind === "author" ? parseAuthorKey(href, base) : parsePerformerKey(href, base);
    const name = anchor.text().replace(/\s+/g, " ").trim();
    if (!key || !name || seen.has(key)) return;
    seen.add(key);
    const countText = anchor.closest("li, .item, tr, .content__main__articles--item").text();
    const countMatch = /\((\d+)\)/.exec(countText);
    out.push({
      key: normaliseKey(key),
      name,
      bookCount: countMatch ? Number.parseInt(countMatch[1]!, 10) : null,
    });
  });

  return out;
}
