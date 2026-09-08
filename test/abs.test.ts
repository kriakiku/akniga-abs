import { describe, expect, test } from "bun:test";
import { defaultConfig } from "../src/config.ts";
import { buildSidecar, sourceTag } from "../src/abs/metadata.ts";
import type { BookWithPeople } from "../src/catalog/store.ts";

function book(partial: Partial<BookWithPeople> = {}): BookWithPeople {
  return {
    source_id: 3167,
    url: "https://akniga.org/x",
    slug: "x",
    title: "Зачистка",
    subtitle: null,
    description: "desc",
    cover_url: null,
    duration_sec: 100,
    rating: null,
    votes: null,
    series_key: "series",
    series_name: "S.T.A.L.K.E.R. Угрюмый",
    series_seq: "2",
    published_year: null,
    lastmod: null,
    first_seen_at: "",
    fetched_at: null,
    content_hash: null,
    work_key: null,
    work_label: null,
    isbn: null,
    asin: null,
    hardcover_book_id: null,
    hardcover_slug: null,
    hardcover_cover_url: null,
    hardcover_series_id: null,
    hardcover_match_kind: null,
    detail_state: "ok",
    detail_error: null,
    authors: ["Гравицкий Алексей"],
    narrators: ["Мрак79"],
    genres: ["Фантастика"],
    tags: ["Фантастика", "S.T.A.L.K.E.R."],
    ...partial,
  };
}

describe("abs metadata", () => {
  test("sourceTag uses akniga prefix", () => {
    const config = defaultConfig();
    expect(sourceTag({ source_id: 3167 }, config)).toBe("akniga:3167");
  });

  test("buildSidecar keeps series tags and language", () => {
    const config = defaultConfig();
    const sidecar = buildSidecar(book(), config);
    expect(sidecar.title).toBe("Зачистка");
    expect(sidecar.authors).toContain("Гравицкий Алексей");
    expect(sidecar.narrators).toContain("Мрак79");
    expect(sidecar.series?.[0]).toContain("S.T.A.L.K.E.R. Угрюмый");
    expect(sidecar.series?.[0]).toContain("#2");
    expect(sidecar.tags).toContain("akniga:3167");
    expect(sidecar.tags).toContain("S.T.A.L.K.E.R.");
    expect(sidecar.language).toBe("rus");
  });
});
