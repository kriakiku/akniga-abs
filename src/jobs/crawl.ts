import type { AppContext } from "../context.ts";
import { getMeta, setMeta } from "../db.ts";
import { logger } from "../log.ts";
import { parseBookPage } from "../source/book.ts";
import { parseEntityIndex } from "../source/indexes.ts";
import { parseListingPage } from "../source/listing.ts";
import {
  authorUrl,
  bookUrl,
  performerUrl,
  searchBooksUrl,
  seriesUrl,
  sectionUrl,
} from "../source/urls.ts";
import {
  addBookTag,
  booksNeedingDetailForSubscriptions,
  markBookState,
  recordBookDetail,
  recordListingCard,
  upsertAuthor,
  upsertNarrator,
  type ListingFacet,
} from "../catalog/store.ts";
import { CooldownError } from "../fetch/fetcher.ts";

const log = logger("crawl");

export interface SeedResult {
  authors: number;
  narrators: number;
}

/**
 * Populate authors and narrators from akniga index pages (best-effort; pages may be paginated).
 */
export async function seedEntities(ctx: AppContext): Promise<SeedResult> {
  const base = ctx.config.source.baseUrl;
  const result: SeedResult = { authors: 0, narrators: 0 };

  try {
    const authorsPage = await ctx.fetcher.getText(`${base}/authors/`);
    for (const entry of parseEntityIndex(authorsPage.body, "author", base)) {
      upsertAuthor(ctx.db, entry);
      result.authors += 1;
    }
  } catch (error) {
    log.warn(`authors index failed: ${String(error)}`);
  }

  try {
    const readersPage = await ctx.fetcher.getText(`${base}/performers/`);
    for (const entry of parseEntityIndex(readersPage.body, "performer", base)) {
      upsertNarrator(ctx.db, entry);
      result.narrators += 1;
    }
  } catch (error) {
    log.warn(`performers index failed: ${String(error)}`);
  }

  setMeta(ctx.db, "seeded_at", new Date().toISOString());
  log.info(`seeded ${result.authors} authors and ${result.narrators} narrators`);
  return result;
}

/** Fetch and store one book detail page. Paid books are recorded as skipped. */
export async function fetchBookDetail(
  ctx: AppContext,
  sourceId: number,
  url?: string,
): Promise<"ok" | "skipped"> {
  const row = ctx.db
    .query<{ url: string; slug: string; lastmod: string | null }, [number]>(
      "select url, slug, lastmod from books where source_id = ?",
    )
    .get(sourceId);
  const target = url ?? row?.url ?? bookUrl(row?.slug ?? String(sourceId), ctx.config.source.baseUrl);

  const page = await ctx.fetcher.getText(target);
  const parsed = parseBookPage(page.body, target, ctx.config.source.baseUrl);

  if (!parsed) {
    markBookState(ctx.db, sourceId, "skipped", "not a book page");
    return "skipped";
  }

  recordBookDetail(ctx.db, parsed, { lastmod: row?.lastmod ?? null });
  if (parsed.isPaid) return "skipped";

  for (const relatedId of parsed.relatedBookIds) {
    const known = ctx.db
      .query<{ source_id: number }, [number]>("select source_id from books where source_id = ?")
      .get(relatedId);
    if (!known) {
      ctx.db
        .query(
          `insert into books (source_id, url, slug, title, first_seen_at, detail_state)
           values (?, ?, ?, '', datetime('now'), 'pending')`,
        )
        .run(relatedId, "", `related-${relatedId}`);
    }
  }

  return "ok";
}

export interface BackfillResult {
  attempted: number;
  ok: number;
  skipped: number;
  errors: number;
}

export async function backfillDetails(ctx: AppContext, limit: number): Promise<BackfillResult> {
  const result: BackfillResult = { attempted: 0, ok: 0, skipped: 0, errors: 0 };
  const pending = booksNeedingDetailForSubscriptions(ctx.db, ctx.config.subscriptions, limit);
  for (const book of pending) {
    result.attempted += 1;
    try {
      const outcome = await fetchBookDetail(ctx, book.source_id, book.url || undefined);
      if (outcome === "ok") result.ok += 1;
      else result.skipped += 1;
    } catch (error) {
      if (error instanceof CooldownError) throw error;
      markBookState(ctx.db, book.source_id, "error", String(error));
      result.errors += 1;
      log.warn(`detail ${book.source_id} failed: ${String(error)}`);
    }
  }
  setMeta(ctx.db, "backfill_at", new Date().toISOString());
  return result;
}

export interface FacetCrawlResult {
  pages: number;
  cards: number;
  free: number;
  paidSkipped: number;
}

export type FacetKind = "author" | "performer" | "series" | "genre" | "search";

function facetListingUrl(kind: FacetKind, key: string, page: number, base: string): string {
  switch (kind) {
    case "author":
      return page <= 1 ? authorUrl(key, base) : `${authorUrl(key, base)}page${page}/`;
    case "performer":
      return page <= 1 ? performerUrl(key, base) : `${performerUrl(key, base)}page${page}/`;
    case "series":
      return page <= 1 ? seriesUrl(key, base) : `${seriesUrl(key, base)}page${page}/`;
    case "genre":
      return page <= 1 ? sectionUrl(key, base) : `${sectionUrl(key, base)}page${page}/`;
    case "search":
      return searchBooksUrl(key, page, base);
  }
}

/**
 * Crawl a facet / search listing and register cards.
 * For `search`, stamps the query string as a tag on every free book.
 */
export async function crawlFacet(
  ctx: AppContext,
  kind: FacetKind | "avtor" | "chitaet" | "cikl",
  key: string,
  maxPages = 5,
  displayName?: string,
): Promise<FacetCrawlResult> {
  const normalised: FacetKind =
    kind === "avtor" ? "author" : kind === "chitaet" ? "performer" : kind === "cikl" ? "series" : kind;

  const base = ctx.config.source.baseUrl;
  const result: FacetCrawlResult = { pages: 0, cards: 0, free: 0, paidSkipped: 0 };
  const storeKind: ListingFacet["kind"] =
    normalised === "author" ? "author" : normalised === "performer" ? "performer" : "series";

  for (let page = 1; page <= maxPages; page++) {
    const url = facetListingUrl(normalised, key, page, base);
    log.info(`facet ${normalised}/${key} page ${page}: ${url}`);
    const response = await ctx.fetcher.getText(url);
    const listing = parseListingPage(response.body, base);
    result.pages += 1;

    const apply = ctx.db.transaction(() => {
      for (const card of listing.cards) {
        result.cards += 1;
        if (card.isPaid && normalised !== "search") {
          // Soft signal from listing; detail page is authoritative. Still record the card.
        }
        if (normalised === "search") {
          recordListingCard(ctx.db, card);
          if (card.seriesName) {
            recordListingCard(ctx.db, card, {
              kind: "series",
              key: card.seriesName,
              name: card.seriesName,
            });
          }
          addBookTag(ctx.db, card.sourceId, key);
          result.free += 1;
        } else if (normalised === "genre") {
          recordListingCard(ctx.db, card);
          result.free += 1;
        } else {
          recordListingCard(ctx.db, card, {
            kind: storeKind,
            key,
            name: displayName ?? key,
          });
          result.free += 1;
        }

        if (card.seriesSequence) {
          ctx.db
            .query("update books set series_seq = coalesce(series_seq, ?) where source_id = ?")
            .run(card.seriesSequence, card.sourceId);
        }
      }
    });
    apply();

    if (page >= listing.lastPage && !listing.nextUrl) break;
    if (listing.cards.length === 0) break;
  }

  return result;
}

export function lastSeedAt(ctx: AppContext): string | null {
  return getMeta(ctx.db, "seeded_at");
}
