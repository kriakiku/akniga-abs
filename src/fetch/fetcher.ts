import type { Config } from "../config.ts";
import { nowIso, type Db } from "../db.ts";
import { logger } from "../log.ts";
import { CookieJar } from "./cookies.ts";
import { AdaptiveLimiter } from "./limiter.ts";

const log = logger("fetch");

export type Strategy = "direct";

export interface FetchResult {
  url: string;
  status: number;
  body: string;
  strategy: Strategy;
}

export interface BinaryResult {
  url: string;
  status: number;
  bytes: Uint8Array;
  contentType: string | null;
}

export class ChallengeError extends Error {
  constructor(readonly url: string) {
    super(`Request blocked for ${url}`);
    this.name = "ChallengeError";
  }
}

export class CooldownError extends Error {
  constructor(readonly remainingMs: number) {
    super(`Source is in cooldown for another ${Math.round(remainingMs / 1000)}s`);
    this.name = "CooldownError";
  }
}

/**
 * Direct HTTP client for akniga.org (no Cloudflare / FlareSolverr).
 * Keeps a cookie jar for LiveStreet session + security key scraping helpers.
 */
export class Fetcher {
  readonly jar: CookieJar;
  readonly limiter: AdaptiveLimiter;
  private audioGate: Promise<void> = Promise.resolve();
  /** Cached LiveStreet security key scraped from an HTML page. */
  private securityKey: string | null = null;
  private securityKeyFetchedAt = 0;

  constructor(
    private readonly db: Db,
    private readonly config: Config,
  ) {
    let primaryHost: string | null = null;
    try {
      primaryHost = new URL(config.source.baseUrl).hostname;
    } catch {
      primaryHost = null;
    }
    this.jar = new CookieJar(db, primaryHost);
    this.limiter = new AdaptiveLimiter({
      minIntervalMs: config.source.minIntervalMs,
      maxIntervalMs: config.source.maxIntervalMs,
      challengeCooldownMs: config.source.challengeCooldownMs,
    });
  }

  /** Kept for UI compatibility; always true (no FlareSolverr required). */
  get flareConfigured(): boolean {
    return true;
  }

  private userAgent(): string {
    return this.jar.userAgent ?? this.config.source.userAgent;
  }

  private browserHeaders(options: {
    referer?: string;
    accept?: string;
    ajax?: boolean;
    origin?: string;
  } = {}): Record<string, string> {
    const headers: Record<string, string> = {
      "user-agent": this.userAgent(),
      accept:
        options.accept ??
        (options.ajax
          ? "application/json, text/javascript, */*; q=0.01"
          : "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8"),
      "accept-language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
    };
    const cookie = this.jar.header();
    if (cookie) headers.cookie = cookie;
    if (options.referer) headers.referer = options.referer;
    if (options.origin) headers.origin = options.origin;
    if (options.ajax) headers["x-requested-with"] = "XMLHttpRequest";
    return headers;
  }

  private record(
    url: string,
    strategy: Strategy | null,
    status: number | null,
    ok: boolean,
    challenge: boolean,
    ms: number,
    error?: string,
  ): void {
    try {
      this.db
        .query(
          "insert into fetch_log (at, url, strategy, status, ok, challenge, ms, error) values (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(nowIso(), url, strategy, status, ok ? 1 : 0, challenge ? 1 : 0, Math.round(ms), error ?? null);
    } catch (error) {
      log.debug(`fetch_log write skipped: ${String(error)}`);
    }
  }

  /** Serialise book audio pipelines so concurrent Accept jobs do not thrash the CDN. */
  async runExclusiveAudio<T>(task: () => Promise<T>): Promise<T> {
    const run = this.audioGate.then(async () => task());
    this.audioGate = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  homeUrl(): string {
    return `${this.config.source.baseUrl.replace(/\/+$/, "")}/`;
  }

  async close(): Promise<void> {
    // Nothing to tear down for direct HTTP.
  }

  async getText(url: string, options: { referer?: string; timeoutMs?: number } = {}): Promise<FetchResult> {
    if (this.limiter.inCooldown()) throw new CooldownError(this.limiter.cooldownRemainingMs());
    await this.limiter.acquire();
    const started = Date.now();
    const timeoutMs = options.timeoutMs ?? this.config.source.requestTimeoutMs;
    try {
      const response = await fetch(url, {
        headers: this.browserHeaders({ referer: options.referer }),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "follow",
      });
      this.jar.absorbSetCookie(response.headers, url);
      const body = await response.text();
      const ok = response.ok;
      if (ok) this.limiter.recordSuccess();
      else this.limiter.recordFailure();
      this.record(url, "direct", response.status, ok, false, Date.now() - started);
      if (!ok) throw new Error(`GET ${url} → ${response.status}`);
      this.captureSecurityKey(body);
      return { url: response.url || url, status: response.status, body, strategy: "direct" };
    } catch (error) {
      this.limiter.recordFailure();
      this.record(url, "direct", null, false, false, Date.now() - started, String(error));
      throw error;
    }
  }

  async getBinary(
    url: string,
    options: { referer?: string; timeoutMs?: number; accept?: string } = {},
  ): Promise<BinaryResult> {
    if (this.limiter.inCooldown()) throw new CooldownError(this.limiter.cooldownRemainingMs());
    await this.limiter.acquire();
    const started = Date.now();
    const timeoutMs = options.timeoutMs ?? this.config.source.requestTimeoutMs;
    try {
      const response = await fetch(url, {
        headers: this.browserHeaders({
          referer: options.referer ?? this.homeUrl(),
          accept: options.accept ?? "*/*",
        }),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "follow",
      });
      this.jar.absorbSetCookie(response.headers, url);
      const bytes = new Uint8Array(await response.arrayBuffer());
      const ok = response.ok;
      if (ok) this.limiter.recordSuccess();
      else this.limiter.recordFailure();
      this.record(url, "direct", response.status, ok, false, Date.now() - started);
      if (!ok) throw new Error(`GET binary ${url} → ${response.status}`);
      return {
        url: response.url || url,
        status: response.status,
        bytes,
        contentType: response.headers.get("content-type"),
      };
    } catch (error) {
      this.limiter.recordFailure();
      this.record(url, "direct", null, false, false, Date.now() - started, String(error));
      throw error;
    }
  }

  /**
   * LiveStreet AJAX POST. Ensures we have a session cookie + security_ls_key first.
   */
  async postAjax(
    path: string,
    fields: Record<string, string | number | boolean>,
    options: { referer?: string; timeoutMs?: number } = {},
  ): Promise<{ status: number; json: Record<string, unknown>; body: string }> {
    const base = this.config.source.baseUrl.replace(/\/+$/, "");
    const url = path.startsWith("http") ? path : `${base}${path.startsWith("/") ? "" : "/"}${path}`;
    const referer = options.referer ?? this.homeUrl();
    const security = await this.ensureSecurityKey(referer);
    const bodyFields: Record<string, string> = {
      security_ls_key: security,
    };
    for (const [key, value] of Object.entries(fields)) {
      bodyFields[key] = String(value);
    }

    if (this.limiter.inCooldown()) throw new CooldownError(this.limiter.cooldownRemainingMs());
    await this.limiter.acquire();
    const started = Date.now();
    const timeoutMs = options.timeoutMs ?? this.config.source.requestTimeoutMs;
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          ...this.browserHeaders({
            referer,
            ajax: true,
            origin: base,
            accept: "application/json, text/javascript, */*; q=0.01",
          }),
          "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        },
        body: new URLSearchParams(bodyFields).toString(),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "follow",
      });
      this.jar.absorbSetCookie(response.headers, url);
      const body = await response.text();
      const ok = response.ok;
      if (ok) this.limiter.recordSuccess();
      else this.limiter.recordFailure();
      this.record(url, "direct", response.status, ok, false, Date.now() - started);
      let json: Record<string, unknown> = {};
      try {
        json = JSON.parse(body) as Record<string, unknown>;
      } catch {
        throw new Error(`POST ${url} returned non-JSON (${response.status}): ${body.slice(0, 120)}`);
      }
      if (!ok) throw new Error(`POST ${url} → ${response.status}`);
      return { status: response.status, json, body };
    } catch (error) {
      this.limiter.recordFailure();
      this.record(url, "direct", null, false, false, Date.now() - started, String(error));
      throw error;
    }
  }

  private captureSecurityKey(html: string): void {
    const match = /LIVESTREET_SECURITY_KEY\s*=\s*'([^']+)'/.exec(html);
    if (match?.[1]) {
      this.securityKey = match[1];
      this.securityKeyFetchedAt = Date.now();
    }
  }

  /** Fetch homepage (or referer) once to obtain PHPSESSID + LIVESTREET_SECURITY_KEY. */
  async ensureSecurityKey(preferUrl?: string): Promise<string> {
    const fresh = Date.now() - this.securityKeyFetchedAt < 25 * 60_000;
    if (this.securityKey && fresh) return this.securityKey;
    const page = await this.getText(preferUrl ?? this.homeUrl());
    this.captureSecurityKey(page.body);
    if (!this.securityKey) throw new Error("Could not extract LIVESTREET_SECURITY_KEY from page");
    return this.securityKey;
  }
}
