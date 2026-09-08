import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { addBookTag, booksForSubscription, recordBookDetail, recordListingCard } from "../src/catalog/store.ts";
import type { ParsedBook } from "../src/source/book.ts";

function sampleBook(overrides: Partial<ParsedBook> = {}): ParsedBook {
  return {
    sourceId: 3167,
    url: "https://akniga.org/gravickiy-aleksey-s-t-a-l-k-e-r-zachistka",
    slug: "gravickiy-aleksey-s-t-a-l-k-e-r-zachistka",
    title: "Зачистка",
    description: "desc",
    coverUrl: null,
    durationSec: 100,
    rating: null,
    votes: null,
    authors: [{ key: "Гравицкий Алексей", name: "Гравицкий Алексей" }],
    narrators: [{ key: "Мрак79", name: "Мрак79" }],
    genres: [{ key: "fantasy", name: "Фантастика" }],
    series: { key: "S.T.A.L.K.E.R. Угрюмый", name: "S.T.A.L.K.E.R. Угрюмый", sequence: "2" },
    tags: ["Фантастика"],
    relatedBookIds: [],
    isPaid: false,
    ...overrides,
  };
}

describe("catalog", () => {
  test("records book and matches series / search tag", () => {
    const dir = mkdtempSync(join(tmpdir(), "akniga-cat-"));
    const db = openDb(dir);
    recordBookDetail(db, sampleBook());
    addBookTag(db, 3167, "S.T.A.L.K.E.R.");

    expect(booksForSubscription(db, "series", "s.t.a.l.k.e.r. угрюмый")).toHaveLength(1);
    expect(booksForSubscription(db, "search", "s.t.a.l.k.e.r.")).toHaveLength(1);
    expect(booksForSubscription(db, "author", "гравицкий алексей")).toHaveLength(1);
    db.close();
  });

  test("paid books are skipped", () => {
    const dir = mkdtempSync(join(tmpdir(), "akniga-paid-"));
    const db = openDb(dir);
    recordBookDetail(db, sampleBook({ sourceId: 1, isPaid: true, title: "Пекло" }));
    const row = db.query<{ detail_state: string; detail_error: string | null }, [number]>(
      "select detail_state, detail_error from books where source_id = ?",
    ).get(1);
    expect(row?.detail_state).toBe("skipped");
    expect(row?.detail_error).toBe("paid");
    db.close();
  });

  test("listing card + series facet", () => {
    const dir = mkdtempSync(join(tmpdir(), "akniga-list-"));
    const db = openDb(dir);
    recordListingCard(
      db,
      {
        sourceId: 3,
        url: "https://akniga.org/book-3",
        slug: "book-3",
        title: "В зоне тумана",
        authorName: "Гравицкий Алексей",
        narratorName: null,
        seriesName: "S.T.A.L.K.E.R. Угрюмый",
        seriesSequence: "1",
        coverUrl: null,
        durationSec: null,
        rating: null,
        votes: null,
        isPaid: false,
      },
      { kind: "series", key: "S.T.A.L.K.E.R. Угрюмый", name: "S.T.A.L.K.E.R. Угрюмый" },
    );
    const row = db.query<{ series_key: string | null }, [number]>(
      "select series_key from books where source_id = ?",
    ).get(3);
    expect(row?.series_key).toBe("S.T.A.L.K.E.R. Угрюмый");
    db.close();
  });
});
