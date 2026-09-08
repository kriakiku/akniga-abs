import { describe, expect, test } from "bun:test";
import {
  buildFfmetadata,
  looksLikeHtmlDocument,
  mapPool,
  parseHlsSegments,
  resolveMediaPlaylist,
} from "../src/audio/m3u.ts";
import { decryptCryptoJsPayload, evpBytesToKey, getHres, playerPassphrase, playerPassphraseFallback } from "../src/source/player.ts";
import { createCipheriv, createHash, randomBytes } from "node:crypto";

describe("hls playlist parsing", () => {
  test("parseHlsSegments extracts urls and key", () => {
    const body = `#EXTM3U
#EXT-X-KEY:METHOD=AES-128,URI="enc.key"
#EXTINF:10.0,
seg0.ts
#EXTINF:10.0,
https://cdn.example/seg1.ts
#EXT-X-ENDLIST
`;
    const { segments, keyUrl } = parseHlsSegments(body, "https://cdn.example/b/1/pl.m3u8");
    expect(keyUrl).toBe("https://cdn.example/b/1/enc.key");
    expect(segments).toEqual(["https://cdn.example/b/1/seg0.ts", "https://cdn.example/seg1.ts"]);
  });

  test("resolveMediaPlaylist follows master playlist", () => {
    const body = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=128000
media.m3u8
`;
    const result = resolveMediaPlaylist(body, "https://cdn.example/master.m3u8");
    expect("redirect" in result).toBe(true);
    if ("redirect" in result) expect(result.redirect).toContain("media.m3u8");
  });

  test("buildFfmetadata writes chapter titles", () => {
    const meta = buildFfmetadata(
      [
        { title: "01. Пролог", time: 100, timeFromStart: 0, duration: 100 },
        { title: "02. Глава", time: 250, timeFromStart: 100, duration: 150 },
      ],
      "Test Book",
    );
    expect(meta).toContain("title=Test Book");
    expect(meta).toContain("title=01. Пролог");
    expect(meta).toContain("START=0");
    expect(meta).toContain("START=100000");
  });

  test("looksLikeHtmlDocument", () => {
    expect(looksLikeHtmlDocument("<!DOCTYPE html><html>")).toBe(true);
    expect(looksLikeHtmlDocument("#EXTM3U\n#EXTINF")).toBe(false);
  });

  test("mapPool preserves order", async () => {
    const out = await mapPool([1, 2, 3, 4], 2, async (n) => n * 10);
    expect(out).toEqual([10, 20, 30, 40]);
  });
});

describe("player decrypt", () => {
  test("passphrase is stable", () => {
    expect(playerPassphrase().startsWith("ymXEKzvUkuo5G0")).toBe(true);
    expect(playerPassphrase().length).toBeGreaterThan(14);
    expect(playerPassphraseFallback()).toBe("EKxtcg46V");
  });

  function seal(passphrase: string, url: string): string {
    const salt = randomBytes(8);
    const { key, iv } = evpBytesToKey(passphrase, salt);
    const plaintext = JSON.stringify(url);
    const cipher = createCipheriv("aes-256-cbc", key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return JSON.stringify({
      ct: encrypted.toString("base64"),
      iv: iv.toString("hex"),
      s: salt.toString("hex"),
    });
  }

  test("round-trip CryptoJS-compatible payload", () => {
    const passphrase = playerPassphrase();
    const payload = seal(passphrase, "https://r1.akniga.club/b/1/pl.m3u8");
    expect(getHres(payload, passphrase)).toBe("https://r1.akniga.club/b/1/pl.m3u8");
    expect(decryptCryptoJsPayload(payload, passphrase)).toBe(JSON.stringify("https://r1.akniga.club/b/1/pl.m3u8"));
    void createHash;
  });

  test("getHres falls back to assets2 key", () => {
    const payload = seal(playerPassphraseFallback(), "https://r1.akniga.club/b/3167/pl.m3u8");
    expect(() => getHres(payload, playerPassphrase())).toThrow();
    expect(getHres(payload)).toBe("https://r1.akniga.club/b/3167/pl.m3u8");
  });
});
