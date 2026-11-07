import { stat } from "node:fs/promises";
import { parseArgs } from "node:util";
import {
  MetaApiError,
  PermissionError,
  RateLimitError,
  TokenExpiredError,
  refreshLongLivedToken,
} from "@/lib/meta/client";
import * as api from "@/lib/meta/publish";
import {
  UserError,
  checkCaption,
  contentType,
  isUrl,
  mediaKind,
  type getUploader,
  type prepareImage,
} from "./media";

export const USAGE = `ig - publish to Instagram via the Content Publishing API

  ig post <image> [--caption "..."]
  ig carousel <img|video> <img|video> ... [--caption "..."]   (2-10 items)
  ig reel <video> [--caption "..."] [--cover <image>] [--share-to-feed] [--trial manual|auto]
  ig story <image|video>
  ig quota
  ig whoami                 (also shows days until the token expires)
  ig refresh-token          renew the token for another 60 days, saved to .env

Media can be local files or public https URLs. Local files go to R2 first.

  --dry-run    validate everything, upload and create nothing
  -y, --yes    skip the confirmation prompt
  --json       print one JSON object to stdout
  --timeout N  seconds to wait for Instagram to process media (default 300)
  --trial      reel only: show to non-followers first. manual = you graduate it in
               the Instagram app; auto = Instagram graduates it if it performs well`;

const TOKEN_FIX =
  "Generate a new token: Meta dashboard -> OpenReply -> Use cases -> Instagram API -> " +
  "API setup with Instagram login -> Generate token, then update IG_ACCESS_TOKEN in openreply/.env.";

// Content publishing subcodes, from Meta's Instagram Graph API error-codes reference.
const SUBCODES: Record<number, [string, string]> = {
  2207001: ["Instagram server error.", "Try again."],
  2207003: ["Instagram timed out downloading the media.", "Try again."],
  2207004: ["The image is over Instagram's 8 MB limit.", "Use a smaller image."],
  2207005: ["Instagram doesn't support this image format.", "Use JPEG."],
  2207006: ["Instagram couldn't find the media (often a missing permission or expired token).", "Check `ig whoami`, then run the command again."],
  2207008: ["The media container isn't ready or has expired.", "Retry in 30 seconds to 2 minutes; if it still fails, run the command again."],
  2207009: ["Instagram rejected the image's aspect ratio.", "Crop it to between 4:5 and 1.91:1."],
  2207010: ["The caption is too long.", "Max 2,200 characters, 30 hashtags and 20 @ tags."],
  2207020: ["The media container expired.", "Run the command again to create a new one."],
  2207023: ["Instagram doesn't recognise the media type.", "Use a supported image or video."],
  2207026: ["Instagram doesn't support this video format.", "Use MP4 or MOV (H.264 video, AAC audio)."],
  2207027: ["The media isn't ready to publish yet.", "Wait a moment and run the command again."],
  2207028: ["Carousels need 2 to 10 photos/videos.", "Change the number of items."],
  2207032: ["Instagram failed to create the media container.", "Try again."],
  2207040: ["Too many @ tags.", "Use at most 20."],
  2207042: ["You've reached the daily publishing limit.", "Try again tomorrow. `ig quota` shows usage."],
  2207050: ["The Instagram account is restricted.", "Open the Instagram app and complete any actions it asks for."],
  2207051: ["Instagram blocked this publish as possible spam.", "Wait before posting again. If it's a mistake, report it in the Instagram app."],
  2207052: ["Instagram couldn't download the media from its URL.", "Make sure the URL opens in a private browser window. For R2, check R2_PUBLIC_URL is the bucket's public domain."],
  2207053: ["Unknown video upload error.", "Try again."],
};

export function explain(err: unknown): { error: string; fix?: string; detail?: string } {
  if (err instanceof UserError) return { error: err.message, fix: err.fix };
  if (err instanceof MetaApiError) {
    const detail = err.message;
    const known = err.subcode ? SUBCODES[err.subcode] : undefined;
    if (known) return { error: known[0], fix: known[1], detail };
    if (err instanceof TokenExpiredError) {
      return { error: "Your Instagram access token is invalid or expired.", fix: TOKEN_FIX, detail };
    }
    if (err instanceof RateLimitError) {
      return { error: "Meta's rate limit was reached.", fix: "Wait a few minutes and retry. `ig quota` shows publishing usage.", detail };
    }
    if (err instanceof PermissionError) {
      return {
        error: "Meta rejected the request: missing permission or invalid parameter.",
        fix:
          "If the detail mentions a permission, check instagram_business_content_publish is added to the app " +
          "and the token was generated after adding it. Otherwise fix the parameter it names.",
        detail,
      };
    }
    return { error: "Meta API error.", detail };
  }
  return { error: err instanceof Error ? err.message : String(err) };
}

export interface Deps {
  env: Record<string, string | undefined>;
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  confirm: (question: string) => Promise<boolean>;
  prepareImage: typeof prepareImage;
  getUploader: typeof getUploader;
  saveEnv: (vars: Record<string, string>) => Promise<void>;
  pollIntervalMs?: number;
}

const daysUntil = (iso: string) => Math.floor((Date.parse(iso) - Date.now()) / 86_400_000);

const TRIAL: Record<string, string> = { manual: "MANUAL", auto: "SS_PERFORMANCE" };

const SPECS = {
  post: { min: 1, max: 1, kinds: ["image"], feed: true },
  carousel: { min: 2, max: 10, kinds: ["image", "video"], feed: true },
  reel: { min: 1, max: 1, kinds: ["video"], feed: false },
  story: { min: 1, max: 1, kinds: ["image", "video"], feed: false },
} as const;

interface Item {
  input: string;
  kind: "image" | "video";
  local: string | null; // file to upload, null when input is already a URL
  converted?: boolean;
  size?: string;
}

export async function run(argv: string[], deps: Deps): Promise<number> {
  const json = argv.includes("--json");
  const print = (data: object, human: string) =>
    deps.stdout(json ? JSON.stringify({ ok: true, ...data }) : human);

  try {
    const { values: o, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        caption: { type: "string", short: "c" },
        cover: { type: "string" },
        "share-to-feed": { type: "boolean" },
        trial: { type: "string" },
        "dry-run": { type: "boolean" },
        yes: { type: "boolean", short: "y" },
        json: { type: "boolean" },
        timeout: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
    const [cmd, ...files] = positionals;
    if (!cmd || o.help) {
      deps.stdout(USAGE);
      return cmd || o.help ? 0 : 1;
    }

    const token = deps.env.IG_ACCESS_TOKEN;
    if (!token) throw new UserError("IG_ACCESS_TOKEN is not set.", "Add it to openreply/.env (see docs/ig-cli.md).");

    if (cmd === "whoami") {
      const a = await api.getAccount(token);
      const expiresAt = deps.env.IG_TOKEN_EXPIRES_AT;
      const left = expiresAt ? daysUntil(expiresAt) : undefined;
      print(
        { ...a, tokenExpiresAt: expiresAt, tokenDaysLeft: left },
        `@${a.username}${a.name ? ` (${a.name})` : ""}, ${a.account_type ?? "account"}, IG user ID ${a.user_id}` +
          (left === undefined ? "" : `\nToken expires ${expiresAt!.slice(0, 10)} (${left} days left)`)
      );
      return 0;
    }
    if (cmd === "refresh-token") {
      // Meta only renews a token that is at least 24h old and not yet expired.
      const { accessToken, expiresIn } = await refreshLongLivedToken(token);
      const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
      await deps.saveEnv({ IG_ACCESS_TOKEN: accessToken, IG_TOKEN_EXPIRES_AT: expiresAt });
      print(
        { tokenExpiresAt: expiresAt, tokenDaysLeft: daysUntil(expiresAt) },
        `Token renewed and saved to .env. It now expires ${expiresAt.slice(0, 10)} (${daysUntil(expiresAt)} days).`
      );
      return 0;
    }
    if (cmd === "quota") {
      const a = await api.getAccount(token);
      const q = await api.getQuota(token, a.user_id);
      const total = q.config?.quota_total;
      const hours = (q.config?.quota_duration ?? 86400) / 3600;
      print(
        { username: a.username, ...q },
        `@${a.username}: ${q.quota_usage}${total ? ` of ${total}` : ""} API posts used in the last ${hours}h`
      );
      return 0;
    }

    const spec = SPECS[cmd as keyof typeof SPECS];
    if (!spec) throw new UserError(`Unknown command "${cmd}".`, "Run `ig --help`.");
    if (files.length < spec.min || files.length > spec.max) {
      throw new UserError(
        spec.min === spec.max
          ? `\`ig ${cmd}\` takes exactly ${spec.min} file, got ${files.length}.`
          : `\`ig ${cmd}\` takes ${spec.min} to ${spec.max} files, got ${files.length}.`
      );
    }
    const caption = typeof o.caption === "string" ? o.caption : undefined;
    if (caption !== undefined && cmd === "story") throw new UserError("Stories can't have a caption.");
    if ((o.cover || o["share-to-feed"] || o.trial) && cmd !== "reel") {
      throw new UserError("--cover, --share-to-feed and --trial only apply to `ig reel`.");
    }
    const graduation = o.trial === undefined ? undefined : TRIAL[o.trial];
    if (o.trial !== undefined && !graduation) throw new UserError(`--trial must be "manual" or "auto", got "${o.trial}".`);
    if (graduation && o["share-to-feed"]) {
      throw new UserError("A trial reel goes to non-followers only, so it can't also be shared to your feed.", "Drop --share-to-feed.");
    }
    const captionErrors = checkCaption(caption ?? "");
    if (captionErrors.length) throw new UserError(captionErrors.join(" "));
    const timeoutSec = o.timeout === undefined ? 300 : Number(o.timeout);
    if (!(timeoutSec > 0)) throw new UserError("--timeout must be a positive number of seconds.");

    const prepare = async (input: string, feed: boolean, allowed: readonly string[]): Promise<Item> => {
      const kind = mediaKind(input);
      if (!allowed.includes(kind)) throw new UserError(`\`ig ${cmd}\` needs ${allowed.join(" or ")}, but ${input} is a ${kind}.`);
      if (isUrl(input)) return { input, kind, local: null };
      if (kind === "image") {
        const p = await deps.prepareImage(input, { feed });
        return { input, kind, local: p.path, converted: p.converted, size: `${p.width}x${p.height}` };
      }
      await stat(input).catch(() => {
        throw new UserError(`File not found: ${input}`);
      });
      return { input, kind, local: input };
    };
    const items: Item[] = [];
    for (const f of files) items.push(await prepare(f, spec.feed, spec.kinds));
    const cover = typeof o.cover === "string" ? await prepare(o.cover, false, ["image"]) : null;

    const account = await api.getAccount(token); // also proves the token works
    const needsUpload = [...items, cover].some((i) => i?.local);
    const upload = needsUpload ? deps.getUploader(deps.env) : null; // fails early if R2 isn't configured

    const plan = {
      command: cmd,
      account: account.username,
      items: items.map(({ input, kind, converted, size }) => ({ input, kind, converted, size })),
      caption,
      cover: cover?.input,
      shareToFeed: cmd === "reel" ? Boolean(o["share-to-feed"]) : undefined,
      trial: graduation,
    };
    if (o["dry-run"]) {
      print(
        { dryRun: true, ...plan },
        `Dry run OK: ${cmd} to @${account.username} with ${items.length} item(s)` +
          `${needsUpload ? ", local files would be uploaded to R2" : ""}. Nothing was uploaded or created.`
      );
      return 0;
    }
    if (!o.yes && !(await deps.confirm(`Publish this ${cmd} to @${account.username}? [y/N] `))) {
      deps.stdout(json ? JSON.stringify({ ok: false, cancelled: true }) : "Cancelled.");
      return 1;
    }

    const urlOf = async (i: Item) => (i.local ? upload!(i.local, contentType(i.local)) : i.input);
    const mediaParam = async (i: Item) =>
      i.kind === "image" ? { image_url: await urlOf(i) } : { video_url: await urlOf(i) };
    const wait = (id: string, label: string) =>
      api.waitUntilFinished(token, id, {
        timeoutMs: timeoutSec * 1000,
        intervalMs: deps.pollIntervalMs,
        onStatus: (status, ms) => {
          if (!json) deps.stderr(`${label}: ${status} (${Math.round(ms / 1000)}s)`);
        },
      });
    const uid = account.user_id;

    let containerId: string;
    if (cmd === "carousel") {
      const children: string[] = [];
      for (const [n, i] of items.entries()) {
        const id = await api.createContainer(token, uid, {
          ...(await mediaParam(i)),
          media_type: i.kind === "video" ? "VIDEO" : undefined,
          is_carousel_item: "true",
        });
        await wait(id, `Item ${n + 1}/${items.length}`);
        children.push(id);
      }
      containerId = await api.createContainer(token, uid, { media_type: "CAROUSEL", children: children.join(","), caption });
    } else if (cmd === "reel") {
      containerId = await api.createContainer(token, uid, {
        media_type: "REELS",
        video_url: await urlOf(items[0]),
        caption,
        cover_url: cover ? await urlOf(cover) : undefined,
        // trial reels are non-follower only, so share_to_feed isn't sent with them
        share_to_feed: graduation ? undefined : String(Boolean(o["share-to-feed"])),
        trial_params: graduation ? JSON.stringify({ graduation_strategy: graduation }) : undefined,
      });
    } else if (cmd === "story") {
      containerId = await api.createContainer(token, uid, { media_type: "STORIES", ...(await mediaParam(items[0])) });
    } else {
      containerId = await api.createContainer(token, uid, { ...(await mediaParam(items[0])), caption });
    }
    await wait(containerId, cmd);
    const mediaId = await api.publishContainer(token, uid, containerId);
    const permalink = await api.getPermalink(token, mediaId);
    print({ command: cmd, account: account.username, mediaId, permalink }, `Published: ${permalink ?? `media ${mediaId}`}`);
    return 0;
  } catch (e) {
    const x = explain(e);
    if (json) deps.stdout(JSON.stringify({ ok: false, ...x }));
    else deps.stderr(`Error: ${x.error}${x.fix ? `\nFix: ${x.fix}` : ""}${x.detail ? `\nMeta said: ${x.detail}` : ""}`);
    return 1;
  }
}
