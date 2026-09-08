import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isPaidBookPage, parseBookPage, parseChapterListFromHtml } from "../src/source/book.ts";
import { extractListingTitle, parseListingPage } from "../src/source/listing.ts";
import {
  authorUrl,
  parseAuthorKey,
  parseBookUrl,
  parseDurationToSeconds,
  parsePerformerKey,
  parseSeriesKey,
  parseSeriesSequence,
  searchBooksUrl,
  seriesUrl,
} from "../src/source/urls.ts";

const fixture = (name: string) => readFileSync(join(import.meta.dir, "fixtures", name), "utf8");

describe("urls", () => {
  test("parseBookUrl accepts slug paths", () => {
    const ref = parseBookUrl("https://akniga.org/gravickiy-aleksey-s-t-a-l-k-e-r-zachistka");
    expect(ref?.slug).toBe("gravickiy-aleksey-s-t-a-l-k-e-r-zachistka");
    expect(parseBookUrl("https://akniga.org/authors/")).toBeNull();
  });

  test("facet keys", () => {
    expect(parseAuthorKey("https://akniga.org/author/Гравицкий%20Алексей/")).toBe("Гравицкий Алексей");
    expect(parsePerformerKey("https://akniga.org/performer/Мрак79/")).toBe("Мрак79");
    expect(parseSeriesKey("https://akniga.org/series/S.T.A.L.K.E.R.%20Угрюмый/")).toContain("S.T.A.L.K.E.R.");
  });

  test("search and series urls", () => {
    expect(searchBooksUrl("S.T.A.L.K.E.R.")).toContain("/search/books/");
    expect(searchBooksUrl("q", 2)).toContain("page2");
    expect(seriesUrl("S.T.A.L.K.E.R. Угрюмый")).toContain("/series/");
    expect(authorUrl("X")).toContain("/author/");
  });

  test("parseSeriesSequence", () => {
    expect(parseSeriesSequence("S.T.A.L.K.E.R. Угрюмый (2)")).toEqual({
      name: "S.T.A.L.K.E.R. Угрюмый",
      sequence: "2",
    });
  });

  test("parseDurationToSeconds", () => {
    expect(parseDurationToSeconds("1:02:03")).toBe(3723);
    expect(parseDurationToSeconds("04:42")).toBe(282);
  });
});

describe("book page", () => {
  test("parses free book metadata and chapters", () => {
    const html = fixture("book-free.html");
    const book = parseBookPage(html, "https://akniga.org/gravickiy-aleksey-s-t-a-l-k-e-r-zachistka");
    expect(book).not.toBeNull();
    expect(book!.sourceId).toBe(3167);
    expect(book!.isPaid).toBe(false);
    expect(book!.authors[0]?.name).toContain("Гравицкий");
    expect(book!.narrators[0]?.name).toBe("Мрак79");
    expect(book!.series?.name).toContain("Угрюмый");
    expect(book!.series?.sequence).toBe("2");
    expect(book!.genres.length).toBeGreaterThan(0);
    expect(book!.tags).toContain("Фантастика");
    expect(book!.description).toContain("зона");
    const chapters = parseChapterListFromHtml(html);
    expect(chapters[0]?.title).toBe("01. Пролог");
  });

  test("marks paid books", () => {
    const html = fixture("book-paid.html");
    expect(isPaidBookPage(html)).toBe(true);
    const book = parseBookPage(html, "https://akniga.org/glushkov-roman-peklo");
    expect(book!.isPaid).toBe(true);
    expect(book!.sourceId).toBe(44455);
  });
});

describe("listing", () => {
  test("extractListingTitle splits authors and ignores synopsis", () => {
    expect(
      extractListingTitle("Зорич Александр, Челяев Сергей – Клад стервятника", [
        "Зорич Александр",
        "Челяев Сергей",
      ]),
    ).toBe("Клад стервятника");
    expect(
      extractListingTitle("Гравицкий Алексей – Зачистка S.T.A.L.K.E.R.", ["Гравицкий Алексей"]),
    ).toBe("Зачистка S.T.A.L.K.E.R.");
    expect(extractListingTitle("Новогодний сборник S.T.A.L.K.E.R", ["Нуждин Андрей"])).toBe(
      "Новогодний сборник S.T.A.L.K.E.R",
    );
  });

  test("parses search results and pagination", () => {
    const page = parseListingPage(fixture("listing-search.html"));
    expect(page.cards.length).toBe(4);
    expect(page.lastPage).toBe(15);
    expect(page.cards[0]).toMatchObject({
      sourceId: 3167,
      title: "Зачистка S.T.A.L.K.E.R.",
      seriesSequence: "2",
    });
    expect(page.cards.find((c) => c.sourceId === 23322)?.title).toBe("Клад стервятника");
    expect(page.cards.find((c) => c.sourceId === 47852)?.title).toBe("Новогодний сборник S.T.A.L.K.E.R");
    // Must not swallow the description blurb that sits inside the same <a>.
    expect(page.cards.find((c) => c.sourceId === 47852)?.title).not.toContain("привыкли");
  });

  test("parses series volume numbers", () => {
    const page = parseListingPage(fixture("listing-series.html"));
    expect(page.cards.map((c) => c.seriesSequence)).toEqual(["1", "2"]);
  });
});
