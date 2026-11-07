import { beforeEach, describe, expect, it, vi } from "vitest";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, type Deps } from "../cli/commands";
import { checkCaption, checkFeedImage } from "../cli/media";

const TOKEN = "secret-test-token";
const IG = "17841400000000000";

type Call = { method: string; path: string; params: Record<string, string> };
let calls: Call[];
let statusSequence: string[];
let failWith: { path: string; error: object } | null;
let nextId: number;

function route(method: string, path: string): object {
  if (failWith && path.endsWith(failWith.path)) return { error: failWith.error };
  if (path.endsWith("/refresh_access_token")) return { access_token: "new-token", token_type: "bearer", expires_in: 5184000 };
  if (path.endsWith("/me")) return { user_id: IG, username: "tryautom", account_type: "BUSINESS" };
  if (path.endsWith("/content_publishing_limit")) {
    return { data: [{ quota_usage: 3, config: { quota_total: 50, quota_duration: 86400 } }] };
  }
  if (method === "POST" && path.endsWith(`${IG}/media`)) return { id: `c${++nextId}` };
  if (method === "POST" && path.endsWith("/media_publish")) return { id: "m1" };
  if (path.endsWith("/m1")) return { permalink: "https://www.instagram.com/p/abc/" };
  return { status_code: statusSequence.shift() ?? "FINISHED" };
}

beforeEach(() => {
  calls = [];
  statusSequence = [];
  failWith = null;
  nextId = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: URL | string, init: RequestInit = {}) => {
      const url = new URL(input);
      const method = init.method ?? "GET";
      expect(url.host).toBe("graph.instagram.com");
      if (url.pathname.endsWith("/refresh_access_token")) {
        expect(url.searchParams.get("access_token")).toBe(TOKEN); // Meta's renew endpoint takes it as a query param
      } else {
        expect(url.toString()).not.toContain(TOKEN); // everywhere else it only travels in the header
        expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
      }
      const params = Object.fromEntries(
        method === "POST" ? new URLSearchParams(init.body as URLSearchParams) : url.searchParams
      );
      calls.push({ method, path: url.pathname, params });
      const body = route(method, url.pathname);
      return new Response(JSON.stringify(body), { status: "error" in body ? 400 : 200, headers: { "content-type": "application/json" } });
    })
  );
});

function makeDeps(overrides: Partial<Deps> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const uploaded: string[] = [];
  const deps: Deps = {
    env: { IG_ACCESS_TOKEN: TOKEN },
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
    confirm: vi.fn(async () => true),
    prepareImage: vi.fn(async (path: string) => ({ path: path.replace(/\.\w+$/, ".jpg"), width: 1080, height: 1350, converted: !path.endsWith(".jpg") })),
    getUploader: vi.fn(() => async (file: string) => {
      uploaded.push(file);
      return `https://cdn.example.com/${file}`;
    }),
    pollIntervalMs: 1,
    saveEnv: vi.fn(async () => {}),
    ...overrides,
  };
  const json = () => JSON.parse(out.at(-1)!);
  return { deps, out, err, uploaded, json };
}

const posts = () => calls.filter((c) => c.method === "POST");

describe("caption and image checks", () => {
  it("enforces 2,200 chars, 30 hashtags, 20 mentions", () => {
    expect(checkCaption("hello #a @b")).toEqual([]);
    expect(checkCaption("x".repeat(2201))[0]).toMatch(/2,200/);
    expect(checkCaption(Array.from({ length: 31 }, (_, i) => `#t${i}`).join(" "))[0]).toMatch(/31 hashtags/);
    expect(checkCaption(Array.from({ length: 21 }, (_, i) => `@u${i}`).join(" "))[0]).toMatch(/21 @mentions/);
    expect(checkCaption("mail me at a@b.com")).toEqual([]); // emails aren't mentions
  });

  it("accepts 4:5 to 1.91:1 and rejects outside", () => {
    expect(checkFeedImage(1080, 1350)).toBeNull();
    expect(checkFeedImage(1080, 566)).toBeNull();
    expect(checkFeedImage(1080, 1920)).toMatch(/outside the feed range/);
    expect(checkFeedImage(300, 300)).toMatch(/320px/);
  });
});

describe("ig cli", () => {
  it("whoami prints the account as JSON", async () => {
    const { deps, json } = makeDeps();
    expect(await run(["whoami", "--json"], deps)).toBe(0);
    expect(json()).toMatchObject({ ok: true, username: "tryautom", user_id: IG });
  });

  it("refresh-token saves the new token and expiry without printing it", async () => {
    const { deps, json, out } = makeDeps();
    expect(await run(["refresh-token", "--json"], deps)).toBe(0);
    expect(calls[0].path).toBe("/v25.0/refresh_access_token");
    expect(calls[0].params.grant_type).toBe("ig_refresh_token");
    expect(deps.saveEnv).toHaveBeenCalledWith({ IG_ACCESS_TOKEN: "new-token", IG_TOKEN_EXPIRES_AT: expect.any(String) });
    expect([59, 60]).toContain(json().tokenDaysLeft);
    expect(out.join()).not.toContain("new-token");
  });

  it("refresh-token on an expired token explains how to get a new one", async () => {
    failWith = { path: "/refresh_access_token", error: { message: "Session has expired", type: "OAuthException", code: 190 } };
    const { deps, json } = makeDeps();
    expect(await run(["refresh-token", "--json"], deps)).toBe(1);
    expect(json().fix).toMatch(/Generate token/);
    expect(deps.saveEnv).not.toHaveBeenCalled();
  });

  it("whoami shows days left when the expiry is known", async () => {
    const in10 = new Date(Date.now() + 10.5 * 86_400_000).toISOString();
    const { deps, json } = makeDeps({ env: { IG_ACCESS_TOKEN: TOKEN, IG_TOKEN_EXPIRES_AT: in10 } });
    await run(["whoami", "--json"], deps);
    expect(json()).toMatchObject({ tokenDaysLeft: 10, tokenExpiresAt: in10 });
  });

  it("quota reads content_publishing_limit", async () => {
    const { deps, out } = makeDeps();
    expect(await run(["quota"], deps)).toBe(0);
    expect(calls.at(-1)!.path).toBe(`/v25.0/${IG}/content_publishing_limit`);
    expect(out[0]).toBe("@tryautom: 3 of 50 API posts used in the last 24h");
  });

  it("post: creates a container, waits, publishes, prints the permalink", async () => {
    statusSequence = ["IN_PROGRESS", "FINISHED"];
    const { deps, json, err } = makeDeps();
    expect(await run(["post", "https://x.com/a.jpg", "-c", "hi", "--yes", "--json"], deps)).toBe(0);
    expect(posts().map((c) => c.path.split("/").pop())).toEqual(["media", "media_publish"]);
    expect(posts()[0].params).toEqual({ image_url: "https://x.com/a.jpg", caption: "hi" });
    expect(posts()[1].params).toEqual({ creation_id: "c1" });
    expect(json()).toMatchObject({ ok: true, mediaId: "m1", permalink: "https://www.instagram.com/p/abc/" });
    expect(err).toEqual([]); // no progress noise in --json mode
    expect(deps.confirm).not.toHaveBeenCalled();
  });

  it("carousel: uploads local files, builds children, then the carousel", async () => {
    const video = join(tmpdir(), "ig-test-c.mp4");
    writeFileSync(video, "fake");
    const { deps, uploaded } = makeDeps();
    expect(await run(["carousel", "a.png", "b.jpg", video, "--caption", "set", "--yes"], deps)).toBe(0);
    expect(uploaded).toEqual(["a.jpg", "b.jpg", video]);
    const created = posts().filter((c) => c.path.endsWith("/media"));
    expect(created.slice(0, 3).map((c) => c.params.is_carousel_item)).toEqual(["true", "true", "true"]);
    expect(created[2].params).toMatchObject({ media_type: "VIDEO", video_url: `https://cdn.example.com/${video}` });
    expect(created[3].params).toMatchObject({ media_type: "CAROUSEL", caption: "set" });
    expect(created[3].params.children.split(",")).toHaveLength(3);
  });

  it("reel passes cover and share_to_feed", async () => {
    const { deps } = makeDeps();
    await run(["reel", "https://x.com/v.mp4", "--cover", "https://x.com/c.jpg", "--share-to-feed", "-y"], deps);
    expect(posts()[0].params).toEqual({
      media_type: "REELS",
      video_url: "https://x.com/v.mp4",
      cover_url: "https://x.com/c.jpg",
      share_to_feed: "true",
    });
  });

  it("reel --trial sends trial_params and no share_to_feed", async () => {
    const { deps, json } = makeDeps();
    expect(await run(["reel", "https://x.com/v.mp4", "--trial", "auto", "-y", "--json"], deps)).toBe(0);
    expect(posts()[0].params).toEqual({
      media_type: "REELS",
      video_url: "https://x.com/v.mp4",
      trial_params: JSON.stringify({ graduation_strategy: "SS_PERFORMANCE" }),
    });
    expect(json().ok).toBe(true);
    calls = [];
    expect(await run(["reel", "https://x.com/v.mp4", "--trial", "maybe", "--json"], deps)).toBe(1);
    expect(await run(["reel", "https://x.com/v.mp4", "--trial", "manual", "--share-to-feed", "--json"], deps)).toBe(1);
    expect(json().error).toMatch(/non-followers/);
    expect(await run(["post", "https://x.com/a.jpg", "--trial", "manual", "--json"], deps)).toBe(1);
    expect(calls).toEqual([]);
  });

  it("story uses STORIES and rejects captions", async () => {
    const { deps } = makeDeps();
    await run(["story", "https://x.com/s.mp4", "-y"], deps);
    expect(posts()[0].params).toEqual({ media_type: "STORIES", video_url: "https://x.com/s.mp4" });
    calls = [];
    expect(await run(["story", "https://x.com/s.jpg", "-c", "no"], deps)).toBe(1);
    expect(calls).toEqual([]);
  });

  it("--dry-run validates and creates nothing", async () => {
    const { deps, json, uploaded } = makeDeps();
    expect(await run(["carousel", "a.heic", "b.jpg", "--dry-run", "--json"], deps)).toBe(0);
    expect(json()).toMatchObject({ ok: true, dryRun: true, account: "tryautom" });
    expect(json().items[0]).toMatchObject({ input: "a.heic", converted: true, size: "1080x1350" });
    expect(posts()).toEqual([]);
    expect(uploaded).toEqual([]);
    expect(deps.getUploader).toHaveBeenCalled(); // config is still checked
  });

  it("declining the prompt publishes nothing", async () => {
    const { deps, out } = makeDeps({ confirm: vi.fn(async () => false) });
    expect(await run(["post", "https://x.com/a.jpg"], deps)).toBe(1);
    expect(posts()).toEqual([]);
    expect(out).toEqual(["Cancelled."]);
  });

  it("rejects bad input before calling the API", async () => {
    const { deps, json } = makeDeps();
    expect(await run(["carousel", "https://x.com/a.jpg", "--json"], deps)).toBe(1);
    expect(json().error).toMatch(/2 to 10 files/);
    expect(await run(["post", "https://x.com/a.jpg", "-c", "x".repeat(2300), "--json"], deps)).toBe(1);
    expect(await run(["reel", "https://x.com/a.jpg", "--json"], deps)).toBe(1);
    expect(json().error).toMatch(/needs video/);
    expect(calls).toEqual([]);
  });

  it("explains an expired token in plain English without leaking it", async () => {
    failWith = { path: "/me", error: { message: "Error validating access token", type: "OAuthException", code: 190 } };
    const { deps, err } = makeDeps();
    expect(await run(["whoami"], deps)).toBe(1);
    expect(err[0]).toMatch(/invalid or expired/);
    expect(err[0]).toMatch(/Generate token/);
    expect(err[0]).not.toContain(TOKEN);
  });

  it("maps Meta subcodes like 2207052 to a fix", async () => {
    failWith = { path: `${IG}/media`, error: { message: "Media download has failed.", code: 9004, error_subcode: 2207052 } };
    const { deps, json } = makeDeps();
    expect(await run(["post", "https://x.com/a.jpg", "-y", "--json"], deps)).toBe(1);
    expect(json()).toMatchObject({ ok: false, error: expect.stringMatching(/couldn't download/) });
    expect(json().fix).toMatch(/private browser window/);
  });

  it("maps a missing permission (code 10)", async () => {
    failWith = { path: `${IG}/media`, error: { message: "Application does not have permission for this action", code: 10 } };
    const { deps, json } = makeDeps();
    await run(["post", "https://x.com/a.jpg", "-y", "--json"], deps);
    expect(json().fix).toMatch(/instagram_business_content_publish/);
  });

  it("times out with a clear error when processing never finishes", async () => {
    statusSequence = Array(1000).fill("IN_PROGRESS");
    const { deps, json } = makeDeps();
    expect(await run(["reel", "https://x.com/v.mp4", "-y", "--json", "--timeout", "0.01"], deps)).toBe(1);
    expect(json().error).toMatch(/Timed out .*last status: IN_PROGRESS/);
    expect(posts().some((c) => c.path.endsWith("media_publish"))).toBe(false);
  });

  it("errors when the token is missing", async () => {
    const { deps, json } = makeDeps({ env: {} });
    expect(await run(["whoami", "--json"], deps)).toBe(1);
    expect(json().error).toMatch(/IG_ACCESS_TOKEN/);
  });
});
