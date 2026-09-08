import { describe, expect, test } from "bun:test";
import { AdaptiveLimiter } from "../src/fetch/limiter.ts";
import { CookieJar, cookieDomainMatchesHost } from "../src/fetch/cookies.ts";
import { openDb } from "../src/db.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("limiter", () => {
  test("backs off after challenges", () => {
    const limiter = new AdaptiveLimiter({
      minIntervalMs: 100,
      maxIntervalMs: 1000,
      challengeCooldownMs: 10_000,
      cooldownAfterChallenges: 2,
    });
    expect(limiter.state().intervalMs).toBe(100);
    limiter.recordChallenge();
    expect(limiter.state().intervalMs).toBeGreaterThan(100);
    limiter.recordChallenge();
    expect(limiter.inCooldown()).toBe(true);
  });
});

describe("cookies", () => {
  test("domain matching", () => {
    expect(cookieDomainMatchesHost("akniga.org", "akniga.org")).toBe(true);
    expect(cookieDomainMatchesHost(".akniga.org", "www.akniga.org")).toBe(true);
    expect(cookieDomainMatchesHost("akniga.org", "evil.com")).toBe(false);
  });

  test("jar stores PHPSESSID", () => {
    const dir = mkdtempSync(join(tmpdir(), "akniga-test-"));
    const db = openDb(dir);
    const jar = new CookieJar(db, "akniga.org");
    jar.set([{ name: "PHPSESSID", value: "abc", domain: "akniga.org" }]);
    expect(jar.phpSessionId()).toBe("abc");
    expect(jar.header("https://akniga.org/")).toContain("PHPSESSID=abc");
    db.close();
  });
});
