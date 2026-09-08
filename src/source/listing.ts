import * as cheerio from "cheerio";
import type { Cheerio, CheerioAPI } from "cheerio";
import type { Element } from "domhandler";
import {
  DEFAULT_BASE_URL,
  absoluteUrl,
  parseBookUrl,
  parseDurationToSeconds,
  parseSeriesSequence,
} from "./urls.ts";

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

function textOf($: CheerioAPI, node: Cheerio<Element>): string {
  return node.text().replace(/\s+/g, " ").trim();
}

/**
 * akniga cards put "Author(s) – Title" in `h2.caption__article-main`, but the wrapping
 * `<a class="content__article-main-link">` also contains the description blurb. Always
 * read the caption (or img alt), never the whole link text.
 */
export function extractListingTitle(
  rawCaption: string,
  authorNames: string[],
  altFallback?: string | null,
): string {
  let title = rawCaption.replace(/\s+/g, " ").trim();
  if (!title && altFallback) title = altFallback.replace(/\s+/g, " ").trim();
  if (!title) return "";

  // Primary pattern on akniga: "Author[, Author2] – Title"
  const enDash = title.split(/\s+[—–]\s+/);
  if (enDash.length >= 2) {
    title = enDash.slice(1).join(" – ").trim();
  } else {
    // ASCII "Author - Title" only when the left side matches a known author link.
    const ascii = /^(.*?)\s+-\s+(.*)$/.exec(title);
    if (ascii) {
      const left = ascii[1]!.trim();
      const right = ascii[2]!.trim();
      const authorsLower = authorNames.map((n) => n.toLowerCase());
      if (
        authorsLower.some((a) => left.toLowerCase() === a || left.toLowerCase().startsWith(`${a},`))
      ) {
        title = right;
      }
    }
  }

  // Strip residual leading author fragments (" , Челяев Сергей") if dash-split missed.
  const authors = [...authorNames].sort((a, b) => b.length - a.length);
  for (const name of authors) {
    if (!name) continue;
    if (title.toLowerCase().startsWith(name.toLowerCase())) {
      title = title.slice(name.length).replace(/^[\s,]+/, "").replace(/^\s*[—–-]\s*/, "").trim();
    }
  }
  title = title.replace(/^[\s,–—-]+/, "").trim();
  return title;
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

      const authorNames = card
        .find('a[href*="/author/"]')
        .toArray()
        .map((el) => textOf($, $(el)))
        .filter(Boolean);
      const authorName = authorNames[0] ?? null;
      const narratorName =
        textOf($, card.find('a[href*="/performer/"]').first()) || null;

      // Caption h2 is authoritative. The wrapping article link also embeds the blurb —
      // strip those nodes before falling back to link text (series cards have title-only links).
      let caption = textOf($, card.find("h2.caption__article-main, .caption__article-main").first());
      if (!caption) {
        caption = textOf($, card.find("h2").first());
      }
      if (!caption) {
        const linkEl = card.find("a.content__article--link, a.content__article-main-link").first().clone();
        linkEl.find(".caption__article--text, .description__article-main, .content__article--image, picture, img").remove();
        caption = textOf($, linkEl);
      }
      const alt =
        card.find("img.topic, img.js-topic, img").first().attr("alt")?.trim() ?? null;
      const title = extractListingTitle(caption, authorNames, alt);
      if (!title) return;

      let seriesName: string | null = null;
      let seriesSequence: string | null = null;
      const seriesText = textOf($, card.find('a[href*="/series/"]').first());
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

      const linkTitle = card.find("a.content__article-main-link, a.content__article--link").first().attr("title") ?? "";
      const isPaid =
        /платн/i.test(card.html() ?? "") ||
        (!/бесплатно/i.test(linkTitle) && /слушать онлайн/i.test(linkTitle));

      cards.push({
        sourceId,
        url,
        slug,
        title,
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

  return { cards, lastPage, nextUrl: nextUrl ?? null };
}
