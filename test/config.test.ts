import { describe, expect, test } from "bun:test";
import { compactConfigText, defaultConfig, parseConfigText } from "../src/config.ts";

describe("config", () => {
  test("defaults point at akniga", () => {
    const config = defaultConfig();
    expect(config.source.baseUrl).toBe("https://akniga.org");
    expect(config.sync.tagPrefix).toBe("akniga");
    expect(config.sync.language).toBe("rus");
    expect(config.subscriptions).toEqual([]);
  });

  test("accepts search subscription", () => {
    const config = parseConfigText(`
subscriptions:
  - type: search
    value: S.T.A.L.K.E.R.
`);
    expect(config.subscriptions).toHaveLength(1);
    expect(config.subscriptions[0]).toMatchObject({ type: "search", value: "S.T.A.L.K.E.R.", enabled: true });
  });

  test("rejects unknown subscription type", () => {
    expect(() => parseConfigText(`subscriptions:\n  - type: foo\n    value: x\n`)).toThrow();
  });

  test("compactConfigText drops defaults", () => {
    const text = compactConfigText(`logLevel: info\nsource:\n  baseUrl: https://akniga.org\n`);
    expect(text).toBe("");
  });

  test("compactConfigText keeps search override", () => {
    const text = compactConfigText(`
subscriptions:
  - type: search
    value: stalker
`);
    expect(text).toContain("search");
    expect(text).toContain("stalker");
  });
});
