import { createDecipheriv, createHash } from "node:crypto";
import type { Fetcher } from "../fetch/fetcher.ts";
import { logger } from "../log.ts";
import { parseChapterListFromHtml } from "./book.ts";

const log = logger("player");

export interface PlayerChapter {
  title: string;
  /** Absolute end time of this chapter in the full book (seconds). */
  time: number;
  /** Start offset within the current media file / book (seconds). */
  timeFromStart: number;
  duration: number;
}

export interface PlayerBookData {
  bid: number;
  title: string;
  titleOnly: string;
  author: string | null;
  hres: string | null;
  res: string | null;
  previewUrl: string | null;
  version: number;
  chapters: PlayerChapter[];
  /** True when only a preview stream is available (paid). */
  isPaidPreview: boolean;
  raw: Record<string, unknown>;
}

/** Passphrase used by akniga's client-side `plh.assets()` (public site JS). */
export function playerPassphrase(): string {
  const base = String.fromCharCode(
    0x79, 0x6d, 0x58, 0x45, 0x4b, 0x7a, 0x76, 0x55, 0x6b, 0x75, 0x6f, 0x35, 0x47, 0x30,
  );
  const pi = Math.PI.toString().slice(0, 0x12);
  const map: Record<number, string> = { 0: "A", 2: "B", 4: "C", 6: "D", 8: "E" };
  let out = base;
  for (const ch of pi) {
    if (/\d/.test(ch)) {
      const n = Number.parseInt(ch, 10);
      out += n % 2 === 0 ? map[n]! : ch;
    } else {
      out += ch;
    }
  }
  return out;
}

/** Fallback key from `plh.assets2()` — current akniga builds encrypt `hres` with this. */
export function playerPassphraseFallback(): string {
  return "EKxtcg46V";
}

/** OpenSSL EVP_BytesToKey (MD5) as used by CryptoJS default AES. */
export function evpBytesToKey(password: string, salt: Buffer, keyLen = 32, ivLen = 16): { key: Buffer; iv: Buffer } {
  const pass = Buffer.from(password, "utf8");
  let derived = Buffer.alloc(0);
  let block = Buffer.alloc(0);
  while (derived.length < keyLen + ivLen) {
    block = createHash("md5").update(Buffer.concat([block, pass, salt])).digest();
    derived = Buffer.concat([derived, block]);
  }
  return { key: derived.subarray(0, keyLen), iv: derived.subarray(keyLen, keyLen + ivLen) };
}

/**
 * Decrypt CryptoJS JSON ciphertext (`{ct,iv,s}`) produced for `hres` / `res`.
 * Returns the UTF-8 plaintext (usually a JSON-encoded URL string).
 */
export function decryptCryptoJsPayload(payload: string, passphrase: string): string {
  const obj = JSON.parse(payload) as { ct: string; iv?: string; s?: string };
  if (!obj.ct || !obj.s) throw new Error("Invalid CryptoJS payload");
  const ct = Buffer.from(obj.ct, "base64");
  const salt = Buffer.from(obj.s, "hex");
  const { key, iv } = evpBytesToKey(passphrase, salt);
  const decipher = createDecipheriv("aes-256-cbc", key, iv);
  const plain = Buffer.concat([decipher.update(ct), decipher.final()]);
  return plain.toString("utf8");
}

function parseDecryptedHres(utf8: string): string {
  const parsed = JSON.parse(utf8) as unknown;
  if (typeof parsed === "string") return parsed;
  if (parsed && typeof parsed === "object" && "url" in (parsed as object)) {
    return String((parsed as { url: string }).url);
  }
  throw new Error("Unexpected decrypted hres shape");
}

/**
 * `plh.getHres` equivalent: try `assets()` then `assets2()` (same order as the site player).
 */
export function getHres(encrypted: string, passphrase?: string): string {
  if (passphrase !== undefined) {
    return parseDecryptedHres(decryptCryptoJsPayload(encrypted, passphrase));
  }
  const keys = [playerPassphrase(), playerPassphraseFallback()];
  let lastError: unknown;
  for (const key of keys) {
    try {
      return parseDecryptedHres(decryptCryptoJsPayload(encrypted, key));
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function parseChapters(raw: unknown): PlayerChapter[] {
  let items: unknown = raw;
  if (typeof items === "string") {
    try {
      items = JSON.parse(items);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(items)) return [];
  const chapters: PlayerChapter[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const title = String(row.title ?? row.name ?? "").trim() || `Chapter ${chapters.length + 1}`;
    const time = Number(row.time ?? row.time_finish ?? 0);
    const timeFromStart = Number(row.time_from_start ?? 0);
    const duration = Number(row.duration ?? Math.max(0, time - timeFromStart));
    chapters.push({
      title,
      time: Number.isFinite(time) ? time : 0,
      timeFromStart: Number.isFinite(timeFromStart) ? timeFromStart : 0,
      duration: Number.isFinite(duration) ? duration : 0,
    });
  }
  return chapters;
}

export async function fetchPlayerToken(fetcher: Fetcher, bid: number, referer: string): Promise<string> {
  const result = await fetcher.postAjax(
    "/ajax/player/token",
    { bid, ts: Date.now() },
    { referer, timeoutMs: 30_000 },
  );
  const token = result.json.token;
  if (typeof token !== "string" || !token) throw new Error(`No player token for bid=${bid}`);
  return token;
}

export async function fetchPlayerBookData(
  fetcher: Fetcher,
  bid: number,
  referer: string,
  options: { hls?: boolean } = {},
): Promise<PlayerBookData> {
  const token = await fetchPlayerToken(fetcher, bid, referer);
  const result = await fetcher.postAjax(
    `/ajax/b/${bid}`,
    { bid, token, hls: options.hls === false ? "false" : "true" },
    { referer, timeoutMs: 45_000 },
  );
  const json = result.json;
  if (json.error || json.bStateError) {
    log.warn(`player data error for ${bid}: ${String(json.error_reason ?? json.sMsg ?? "unknown")}`);
  }

  const hres = typeof json.hres === "string" ? json.hres : null;
  const res = typeof json.res === "string" ? json.res : null;
  const previewUrl = typeof json.preview_url === "string" ? json.preview_url : null;
  const chapters = parseChapters(json.items);
  const isPaidPreview = Boolean(previewUrl && !hres && !res);

  return {
    bid,
    title: String(json.title ?? json.titleonly ?? ""),
    titleOnly: String(json.titleonly ?? json.title ?? ""),
    author: typeof json.author === "string" ? json.author : null,
    hres,
    res,
    previewUrl,
    version: Number(json.version ?? 1) || 1,
    chapters,
    isPaidPreview,
    raw: json,
  };
}

export function resolveMediaUrl(data: PlayerBookData): { url: string; kind: "hls" | "mp3" } | null {
  if (data.isPaidPreview) return null;
  try {
    if (data.hres) {
      const url = getHres(data.hres);
      const withVersion = data.version > 1 ? `${url}${url.includes("?") ? "&" : "?"}v=${data.version}` : url;
      return { url: withVersion, kind: "hls" };
    }
    if (data.res) {
      return { url: getHres(data.res), kind: "mp3" };
    }
  } catch (error) {
    log.warn(`decrypt failed for bid=${data.bid}: ${String(error)}`);
  }
  return null;
}

/** Prefer player AJAX chapters; fall back to HTML chapter list. */
export function chaptersForBook(data: PlayerBookData, html?: string): PlayerChapter[] {
  if (data.chapters.length > 0) return data.chapters;
  if (!html) return [];
  const fromHtml = parseChapterListFromHtml(html);
  return fromHtml.map((ch, index, all) => {
    const next = all[index + 1];
    const start = ch.startSec ?? 0;
    const end = next?.startSec ?? start;
    return {
      title: ch.title,
      timeFromStart: start,
      time: end,
      duration: Math.max(0, end - start),
    };
  });
}
