import * as cheerio from "cheerio";
import {
  DEFAULT_BASE_URL,
  absoluteUrl,
  parseBookUrl,
  parseDurationToSeconds,
  parseSeriesSequence,
} from "./urls.ts";
import { isPaidBookPage } from "./book.ts";

export interface ListingCard {
  sourceId: number;
  url: string;
  slug: string;
  title: string;
  authorName: string | null;
  narratorName: string | null;
  seriesName: string | null;
  seriesSequence: string | null;
  coverUrl: string | null;
  durationSec: number | null;
  rating: number | null;
  votes: number | null;
  /** True when the card / linked book looks paid. */
  isPaid: boolean;
}

export interface ListingPage {
  cards: ListingCard[];
  /** Highest page number advertised by the pager, 1 when there is no pager. */
  lastPage: number;
  /** Next "load more" URL when present. */
  nextUrl: string | null;
}

/**
 * Parse akniga listing grids: search results, series pages, author/performer pages.
 */
export function parseListingPage(html: string, base = DEFAULT_BASE_URL): ListingPage {
  const $ = cheerio.load(html);
  const cards: ListingCard[] = [];
  const seen = new Set<number>();

  $(".content__main__articles--pageBooks, .content__main__articles--series-item, .topic.js-topic").each(
    (_, element) => {
      const card = $(element);
      // Prefer article link inside the card.
      const link =
        card.find("a.content__article--link, a.content__article-main-link").first().attr("href") ??
        card.find("a[href]").first().attr("href");
      const ref = parseBookUrl(link, base);
      const bidRaw =
        card.attr("data-bid") ??
        card.find("[data-bid]").first().attr("data-bid") ??
        card.find("[data-param-i-target-id]").first().attr("data-param-i-target-id");
      const sourceId = bidRaw ? Number.parseInt(bidRaw, 10) : Number.NaN;
      if (!Number.isFinite(sourceId) || sourceId <= 0) return;
      if (seen.has(sourceId)) return;
      seen.add(sourceId);

      const title =
        card.find(".caption__article-main, h2, .content__article-main-link").first().text().replace(/\s+/g, " ").trim() ||
        card.find("a.content__article--link").first().text().replace(/\s+/g, " ").trim();
      if (!title) return;

      const authorName =
        card.find('a[href*="/author/"]').first().text().replace(/\s+/g, " ").trim() || null;
      const narratorName =
        card.find('a[href*="/performer/"]').first().text().replace(/\s+/g, " ").trim() || null;

      let seriesName: string | null = null;
      let seriesSequence: string | null = null;
      const seriesText = card.find('a[href*="/series/"]').first().text().replace(/\s+/g, " ").trim();
      if (seriesText) {
        const parsed = parseSeriesSequence(seriesText);
        seriesName = parsed.name;
        seriesSequence = parsed.sequence;
      }
      // Series page volume number.
      const numberLabel = card.find("span.number").first().text().trim();
      if (numberLabel && /^\d+$/.test(numberLabel)) {
        seriesSequence = numberLabel;
      }

      const durationText = card.find(".caption__article-duration, .link__action--time").first().text();
      const durationSec = parseDurationToSeconds(durationText.replace(/[^\d:]/g, " ").trim().split(/\s+/).pop());

      const votesRaw = card.find("[data-vote-num-id]").first().text().trim();
      const votes = votesRaw ? Number.parseInt(votesRaw.replace(/\D+/g, ""), 10) : Number.NaN;

      const slug = ref?.slug ?? `book-${sourceId}`;
      const url = ref?.url ?? absoluteUrl(link, base) ?? `${base.replace(/\/+$/, "")}/${slug}`;

      // Paid cards: title/page snippet without «бесплатно» — for search we also check later on detail.
      const cardHtml = card.html() ?? "";
      const isPaid =
        /платн/i.test(cardHtml) ||
        (!/бесплатно/i.test(title) && /слушать онлайн/i.test(card.find("a").first().attr("title") ?? ""));

      cards.push({
        sourceId,
        url,
        slug,
        title: title.replace(/\s+[—–-]\s+.*$/, (m) => {
          // Keep "Author – Title" style: akniga often uses "Author – Title synopsis…"
          const parts = title.split(/\s+[—–-]\s+/);
          if (parts.length >= 2) return ""; // strip synopsis after first dash? Better keep full and clean below.
          return m;
        }).split(/\s{2,}/)[0]!.trim(),
        authorName,
        narratorName,
        seriesName,
        seriesSequence,
        coverUrl: absoluteUrl(
          card.find("img").first().attr("src") ?? card.find("img").first().attr("data-src"),
          base,
        ),
        durationSec,
        rating: null,
        votes: Number.isFinite(votes) ? votes : null,
        isPaid,
      });
    },
  );

  // Clean titles that look like "Author – Title Synopsis…"
  for (const card of cards) {
    if (card.authorName && card.title.startsWith(card.authorName)) {
      card.title = card.title
        .slice(card.authorName.length)
        .replace(/^\s*[—–-]\s*/, "")
        .trim();
    }
    // Truncate at long synopsis: title links often include description inline.
    const cut = card.title.search(/\.\s+[А-ЯA-Z]/);
    if (cut > 20) card.title = card.title.slice(0, cut + 1).trim();
  }

  let lastPage = 1;
  $(".paging a[href], .pagination a[href]").each((_, element) => {
    const href = $(element).attr("href") ?? "";
    const pageMatch = /\/page\/?(\d+)/i.exec(href) || /page(\d+)/i.exec(href);
    if (pageMatch) lastPage = Math.max(lastPage, Number.parseInt(pageMatch[1]!, 10));
    const text = $(element).text().trim();
    const asNum = Number.parseInt(text, 10);
    if (Number.isFinite(asNum)) lastPage = Math.max(lastPage, asNum);
  });

  const nextUrl =
    absoluteUrl($(".js-loadmore-button").attr("data-url"), base) ??
    absoluteUrl($(".paging a:contains('»'), .paging a.next").attr("href"), base);

  void isPaidBookPage;
  return { cards, lastPage, nextUrl: nextUrl ?? null };
}
