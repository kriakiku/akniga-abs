import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Config } from "../config.ts";
import type { BookWithPeople } from "../catalog/store.ts";
import type { Fetcher } from "../fetch/fetcher.ts";
import { isMediaFile } from "../abs/stage.ts";
import { logger } from "../log.ts";
import {
  chaptersForBook,
  fetchPlayerBookData,
  resolveMediaUrl,
  type PlayerChapter,
} from "../source/player.ts";

const log = logger("audio");

const AUDIO_MARKER = ".akniga-audio-done";
const TRACKS_MANIFEST = ".akniga-audio-tracks.json";
const CHAPTERS_FILE = "chapters.json";

export interface AudioFetchResult {
  playlistUrl: string;
  tracks: number;
  downloaded: number;
  skipped: number;
  files: string[];
}

export type AudioTrackStatus = "downloaded" | "pending";

export interface AudioTrackInfo {
  name: string;
  file: string;
  status: AudioTrackStatus;
}

export interface AudioStatus {
  files: AudioTrackInfo[];
  downloaded: number;
  total: number;
  complete: boolean;
}

interface TracksManifest {
  mediaUrl: string;
  kind: "hls" | "mp3";
  output: string;
  chapters: Array<{ title: string; startSec: number; endSec: number }>;
}

export async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index]!, index);
    }
  });
  await Promise.all(runners);
  return results;
}

async function fileLooksComplete(path: string, minFileBytes: number): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isFile() && info.size >= minFileBytes;
  } catch {
    return false;
  }
}

async function readTracksManifest(dir: string): Promise<TracksManifest | null> {
  try {
    const raw = await readFile(join(dir, TRACKS_MANIFEST), "utf8");
    return JSON.parse(raw) as TracksManifest;
  } catch {
    return null;
  }
}

export async function readAudioStatus(dir: string, minFileBytes: number): Promise<AudioStatus> {
  const manifest = await readTracksManifest(dir);
  if (manifest?.output) {
    const done = await fileLooksComplete(join(dir, manifest.output), minFileBytes);
    const files: AudioTrackInfo[] = [
      {
        name: manifest.output,
        file: manifest.output,
        status: done ? "downloaded" : "pending",
      },
    ];
    return {
      files,
      downloaded: done ? 1 : 0,
      total: 1,
      complete: done,
    };
  }

  const files: AudioTrackInfo[] = [];
  try {
    for (const name of await readdir(dir)) {
      if (!isMediaFile(name)) continue;
      if (!(await fileLooksComplete(join(dir, name), minFileBytes))) continue;
      files.push({ name, file: name, status: "downloaded" });
    }
  } catch {
    // missing dir
  }
  files.sort((a, b) => a.file.localeCompare(b.file));
  return {
    files,
    downloaded: files.length,
    total: files.length,
    complete: files.length > 0,
  };
}

export async function clearDownloadedAudio(dir: string): Promise<number> {
  let removed = 0;
  try {
    for (const name of await readdir(dir)) {
      if (name.startsWith(".")) {
        if (name === AUDIO_MARKER || name === TRACKS_MANIFEST || name.startsWith(".tmp-")) {
          await rm(join(dir, name), { force: true });
        }
        continue;
      }
      if (isMediaFile(name) || name === CHAPTERS_FILE || name === "ffmetadata.txt") {
        await rm(join(dir, name), { force: true });
        if (isMediaFile(name)) removed += 1;
      }
    }
    await rm(join(dir, "hls"), { recursive: true, force: true });
  } catch {
    // ignore
  }
  return removed;
}

export async function clearBookFolder(dir: string): Promise<{ audio: number; wiped: boolean }> {
  let audio = 0;
  try {
    for (const name of await readdir(dir)) {
      if (isMediaFile(name)) audio += 1;
    }
  } catch {
    return { audio: 0, wiped: false };
  }
  await rm(dir, { recursive: true, force: true });
  return { audio, wiped: true };
}

/** Parse an HLS media playlist into ordered segment URLs (and optional key URL). */
export function parseHlsSegments(body: string, baseUrl: string): { segments: string[]; keyUrl: string | null } {
  const segments: string[] = [];
  let keyUrl: string | null = null;
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("#EXT-X-KEY:")) {
      const uri = /URI="([^"]+)"/.exec(line)?.[1];
      if (uri) {
        try {
          keyUrl = new URL(uri, baseUrl).toString();
        } catch {
          keyUrl = uri;
        }
      }
      continue;
    }
    if (line.startsWith("#")) continue;
    try {
      segments.push(new URL(line, baseUrl).toString());
    } catch {
      // skip
    }
  }
  return { segments, keyUrl };
}

/** If the body is a master playlist, pick the first media playlist URL. */
export function resolveMediaPlaylist(body: string, baseUrl: string): { body: string; url: string } | { redirect: string } {
  if (body.includes("#EXT-X-STREAM-INF")) {
    for (const rawLine of body.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      try {
        return { redirect: new URL(line, baseUrl).toString() };
      } catch {
        continue;
      }
    }
  }
  return { body, url: baseUrl };
}

export function buildFfmetadata(chapters: PlayerChapter[], title: string): string {
  const lines = [";FFMETADATA1", `title=${escapeMeta(title)}`];
  for (let i = 0; i < chapters.length; i++) {
    const chapter = chapters[i]!;
    const start = Math.max(0, Math.round(chapter.timeFromStart * 1000));
    const endCandidate = chapter.time > chapter.timeFromStart ? chapter.time : chapter.timeFromStart + chapter.duration;
    const end = Math.max(start + 1, Math.round(endCandidate * 1000));
    lines.push("[CHAPTER]", "TIMEBASE=1/1000", `START=${start}`, `END=${end}`, `title=${escapeMeta(chapter.title)}`);
  }
  return `${lines.join("\n")}\n`;
}

function escapeMeta(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/=/g, "\\=").replace(/;/g, "\\;").replace(/#/g, "\\#").replace(/\n/g, " ");
}

async function runFfmpeg(args: string[]): Promise<void> {
  const proc = Bun.spawn(["ffmpeg", "-y", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (exitCode !== 0) {
    throw new Error(`ffmpeg failed (${exitCode}): ${stderr.slice(-800)}`);
  }
}

/**
 * Download HLS (.ts) or single mp3 for a book and remux into one `.m4b` with chapter names.
 * Export name kept as `ensureAudioFromPlaylist` for call-site compatibility.
 */
export async function ensureAudioFromPlaylist(
  book: BookWithPeople,
  dir: string,
  config: Config,
  fetcher: Fetcher,
): Promise<AudioFetchResult> {
  await mkdir(dir, { recursive: true });
  const existing = await readAudioStatus(dir, config.audio.minFileBytes);
  if (existing.complete) {
    return {
      playlistUrl: "",
      tracks: existing.total,
      downloaded: existing.downloaded,
      skipped: existing.downloaded,
      files: existing.files.map((f) => f.file),
    };
  }

  return fetcher.runExclusiveAudio(async () => {
    const referer = book.url || `${config.source.baseUrl}/`;
    log.info(`audio ${book.source_id}: fetching player token/playlist`);
    const player = await fetchPlayerBookData(fetcher, book.source_id, referer, { hls: true });
    if (player.isPaidPreview) {
      throw new Error(`book ${book.source_id} is paid (preview only)`);
    }
    const media = resolveMediaUrl(player);
    if (!media) throw new Error(`no playable media for book ${book.source_id}`);

    const chapters = chaptersForBook(player);
    const outputName = `${String(book.source_id).padStart(4, "0")}-${safeSlug(book.slug || book.title)}.m4b`;
    const outputPath = join(dir, outputName);
    log.info(
      `audio ${book.source_id}: ${media.kind}, ${chapters.length} chapter(s) → ${outputName}`,
    );

    const manifest: TracksManifest = {
      mediaUrl: media.url,
      kind: media.kind,
      output: outputName,
      chapters: chapters.map((ch) => ({
        title: ch.title,
        startSec: ch.timeFromStart,
        endSec: ch.time > ch.timeFromStart ? ch.time : ch.timeFromStart + ch.duration,
      })),
    };
    await writeFile(join(dir, TRACKS_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(join(dir, CHAPTERS_FILE), `${JSON.stringify(manifest.chapters, null, 2)}\n`);

    if (media.kind === "mp3") {
      log.info(`audio ${book.source_id}: downloading single mp3`);
      const binary = await fetcher.getBinary(media.url, {
        referer,
        timeoutMs: config.audio.trackTimeoutMs,
        accept: "*/*",
      });
      const mp3Path = join(dir, ".tmp-source.mp3");
      await writeFile(mp3Path, binary.bytes);
      log.info(`audio ${book.source_id}: remuxing mp3 → m4b with chapters`);
      await remuxWithChapters(mp3Path, outputPath, chapters, book.title);
      await rm(mp3Path, { force: true });
    } else {
      await downloadHlsAndRemux(
        media.url,
        dir,
        outputPath,
        chapters,
        book.title,
        config,
        fetcher,
        referer,
        book.source_id,
      );
    }

    await writeFile(join(dir, AUDIO_MARKER), `${new Date().toISOString()}\n`);
    return {
      playlistUrl: media.url,
      tracks: 1,
      downloaded: 1,
      skipped: 0,
      files: [outputName],
    };
  });
}

async function downloadHlsAndRemux(
  playlistUrl: string,
  dir: string,
  outputPath: string,
  chapters: PlayerChapter[],
  title: string,
  config: Config,
  fetcher: Fetcher,
  referer: string,
  sourceId: number,
): Promise<void> {
  const hlsDir = join(dir, "hls");
  await mkdir(hlsDir, { recursive: true });

  log.info(`audio ${sourceId}: fetching HLS playlist`);
  let currentUrl = playlistUrl;
  let playlistBody = (
    await fetcher.getText(currentUrl, { referer, timeoutMs: config.audio.playlistTimeoutMs })
  ).body;
  const resolved = resolveMediaPlaylist(playlistBody, currentUrl);
  if ("redirect" in resolved) {
    currentUrl = resolved.redirect;
    playlistBody = (await fetcher.getText(currentUrl, { referer, timeoutMs: config.audio.playlistTimeoutMs })).body;
  }

  const { segments, keyUrl } = parseHlsSegments(playlistBody, currentUrl);
  if (segments.length === 0) throw new Error(`HLS playlist has no segments: ${currentUrl}`);

  if (keyUrl) {
    log.info(`audio ${sourceId}: downloading HLS encryption key`);
    const key = await fetcher.getBinary(keyUrl, { referer, timeoutMs: config.audio.trackTimeoutMs });
    await writeFile(join(hlsDir, "enc.key"), key.bytes);
  }

  const total = segments.length;
  const progress = createSegmentProgress(sourceId, total);
  log.info(
    `audio ${sourceId}: downloading ${total} HLS segment(s) (concurrency ${config.audio.trackConcurrency})`,
  );

  // Rewrite playlist to local segment names for ffmpeg.
  const localNames: string[] = [];
  await mapPool(segments, config.audio.trackConcurrency, async (url, index) => {
    const name = `seg-${String(index).padStart(5, "0")}.ts`;
    localNames[index] = name;
    const dest = join(hlsDir, name);
    if (await fileLooksComplete(dest, config.audio.minFileBytes)) {
      progress.tick(true);
      return;
    }
    const binary = await fetcher.getBinary(url, {
      referer,
      timeoutMs: config.audio.trackTimeoutMs,
      accept: "*/*",
    });
    const tmp = join(hlsDir, `.tmp-${name}`);
    await writeFile(tmp, binary.bytes);
    await rename(tmp, dest);
    progress.tick(false);
  });
  progress.done();

  const localPlaylist = playlistBody
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        if (trimmed.startsWith("#EXT-X-KEY:") && keyUrl) {
          return trimmed.replace(/URI="[^"]+"/, 'URI="enc.key"');
        }
        return line;
      }
      // Map remote segment line to local file by order.
      const idx = localNames.findIndex((n) => n && !n.startsWith("used:"));
      // simpler: rebuild from segments list
      return line;
    })
    .join("\n");

  // Rebuild a clean media playlist pointing at local files.
  const rebuilt: string[] = ["#EXTM3U", "#EXT-X-VERSION:3"];
  if (keyUrl) rebuilt.push('#EXT-X-KEY:METHOD=AES-128,URI="enc.key"');
  // Copy EXTINF lines from original in order.
  let segIndex = 0;
  for (const rawLine of playlistBody.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("#EXTINF:")) {
      rebuilt.push(line);
      const name = localNames[segIndex++];
      if (name) rebuilt.push(name);
    } else if (line.startsWith("#EXT-X-TARGETDURATION") || line.startsWith("#EXT-X-MEDIA-SEQUENCE") || line.startsWith("#EXT-X-PLAYLIST-TYPE")) {
      rebuilt.push(line);
    } else if (line === "#EXT-X-ENDLIST") {
      rebuilt.push(line);
    }
  }
  if (!rebuilt.includes("#EXT-X-ENDLIST")) rebuilt.push("#EXT-X-ENDLIST");
  const listPath = join(hlsDir, "local.m3u8");
  await writeFile(listPath, `${rebuilt.join("\n")}\n`);
  void localPlaylist;

  const concatPath = join(hlsDir, "concat.txt");
  log.info(`audio ${sourceId}: ffmpeg remux ${localNames.length} segment(s) → ${basename(outputPath)}`);
  // Prefer concat demuxer of .ts files — more reliable than encrypted local m3u8 if key path issues.
  if (!keyUrl) {
    await writeFile(concatPath, localNames.map((n) => `file '${n.replace(/'/g, "'\\''")}'`).join("\n") + "\n");
    const tmpOut = join(dir, ".tmp-out.m4b");
    await runFfmpeg([
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      concatPath,
      "-c",
      "copy",
      "-vn",
      tmpOut,
    ]);
    await remuxWithChapters(tmpOut, outputPath, chapters, title);
    await rm(tmpOut, { force: true });
  } else {
    const tmpOut = join(dir, ".tmp-out.m4b");
    await runFfmpeg(["-allowed_extensions", "ALL", "-i", listPath, "-c", "copy", "-vn", tmpOut]);
    await remuxWithChapters(tmpOut, outputPath, chapters, title);
    await rm(tmpOut, { force: true });
  }

  // Drop bulky HLS workspace after success.
  await rm(hlsDir, { recursive: true, force: true });
  log.info(`audio ${sourceId}: done → ${basename(outputPath)}`);
}

/** Log segment download progress with remaining count and ETA. */
function createSegmentProgress(sourceId: number, total: number) {
  const startedAt = Date.now();
  let done = 0;
  let skipped = 0;
  let lastLogAt = 0;
  const step = Math.max(1, Math.min(25, Math.ceil(total / 10)));

  const emit = (force = false) => {
    const now = Date.now();
    if (!force && done < total && done % step !== 0 && now - lastLogAt < 15_000) return;
    lastLogAt = now;
    const left = total - done;
    const elapsedSec = Math.max(0.001, (now - startedAt) / 1000);
    const rate = done / elapsedSec;
    const etaSec = rate > 0 && left > 0 ? Math.round(left / rate) : null;
    const eta = etaSec === null ? "?" : etaSec < 60 ? `${etaSec}s` : `${Math.round(etaSec / 60)}m`;
    const skipNote = skipped > 0 ? `, ${skipped} cached` : "";
    log.info(
      `audio ${sourceId}: segments ${done}/${total} (${left} left, ~${eta})${skipNote}`,
    );
  };

  return {
    tick(wasCached: boolean) {
      done += 1;
      if (wasCached) skipped += 1;
      emit(false);
    },
    done() {
      emit(true);
    },
  };
}

async function remuxWithChapters(
  inputPath: string,
  outputPath: string,
  chapters: PlayerChapter[],
  title: string,
): Promise<void> {
  const metaPath = `${outputPath}.ffmeta`;
  await writeFile(metaPath, buildFfmetadata(chapters, title));
  const tmp = `${outputPath}.tmp`;
  try {
    await runFfmpeg([
      "-i",
      inputPath,
      "-i",
      metaPath,
      "-map_metadata",
      "1",
      "-c",
      "copy",
      "-movflags",
      "+faststart",
      tmp,
    ]);
    await rename(tmp, outputPath);
  } finally {
    await rm(metaPath, { force: true });
    await rm(tmp, { force: true });
  }
}

function safeSlug(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80) || "book";
}

/** @deprecated alias kept for tests */
export function parseM3u(body: string, baseUrl?: string): Array<{ url: string; title: string | null }> {
  const { segments } = parseHlsSegments(body, baseUrl ?? "https://example.invalid/");
  return segments.map((url) => ({ url, title: null }));
}

export function looksLikeHtmlDocument(raw: string): boolean {
  const head = raw.trim().slice(0, 256).toLowerCase();
  return head.startsWith("<!doctype") || head.startsWith("<html") || head.includes("<head");
}
