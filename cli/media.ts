import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { promisify } from "node:util";
import { AwsClient } from "aws4fetch";

const run = promisify(execFile);

export class UserError extends Error {
  constructor(message: string, public fix?: string) {
    super(message);
  }
}

const IMAGE_EXT = [".jpg", ".jpeg", ".png", ".heic", ".heif", ".webp"];
const VIDEO_EXT = [".mp4", ".mov"];
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export const isUrl = (s: string) => /^https?:\/\//i.test(s);

export function mediaKind(input: string): "image" | "video" {
  const ext = extname(isUrl(input) ? new URL(input).pathname : input).toLowerCase();
  if (IMAGE_EXT.includes(ext)) return "image";
  if (VIDEO_EXT.includes(ext)) return "video";
  throw new UserError(
    `Can't tell whether "${input}" is an image or a video (extension "${ext || "none"}").`,
    `Use ${[...IMAGE_EXT, ...VIDEO_EXT].join(", ")}.`
  );
}

export function checkCaption(caption: string): string[] {
  const errors: string[] = [];
  const length = [...caption].length;
  const hashtags = caption.match(/#[\p{L}\p{N}_]+/gu)?.length ?? 0;
  const mentions = caption.match(/(^|[^\w])@[\w.]+/g)?.length ?? 0;
  if (length > 2200) errors.push(`Caption is ${length} characters; the limit is 2,200.`);
  if (hashtags > 30) errors.push(`Caption has ${hashtags} hashtags; the limit is 30.`);
  if (mentions > 20) errors.push(`Caption has ${mentions} @mentions; the limit is 20.`);
  return errors;
}

/** Feed images must be between 4:5 (portrait) and 1.91:1 (landscape). */
export function checkFeedImage(width: number, height: number): string | null {
  const ratio = width / height;
  if (width < 320) return `Image is ${width}px wide; Instagram needs at least 320px.`;
  if (ratio < 0.8 - 0.005 || ratio > 1.91 + 0.005) {
    return `Aspect ratio ${width}x${height} (${ratio.toFixed(2)}:1) is outside the feed range 4:5 (0.80) to 1.91:1. Crop the image.`;
  }
  return null;
}

export interface PreparedImage {
  path: string;
  width: number;
  height: number;
  converted: boolean;
}

// shortcut: uses macOS `sips` for HEIC/PNG/WebP -> JPEG and dimensions; swap in sharp if this ever runs off a Mac.
export async function prepareImage(path: string, opts: { feed: boolean }): Promise<PreparedImage> {
  await stat(path).catch(() => {
    throw new UserError(`File not found: ${path}`);
  });
  const info = async (p: string) => {
    const { stdout } = await run("sips", ["-g", "pixelWidth", "-g", "pixelHeight", "-g", "format", p]);
    const get = (k: string) => stdout.match(new RegExp(`${k}: (\\S+)`))?.[1];
    return { width: Number(get("pixelWidth")), height: Number(get("pixelHeight")), format: get("format") };
  };
  const { width, height, format } = await info(path);
  let out = path;
  if (format !== "jpeg") {
    out = join(await mkdtemp(join(tmpdir(), "ig-")), basename(path, extname(path)) + ".jpg");
    await run("sips", ["-s", "format", "jpeg", "-s", "formatOptions", "90", path, "--out", out]).catch(() => {
      throw new UserError(`Couldn't convert ${path} (${format}) to JPEG.`);
    });
  }
  const { size } = await stat(out);
  if (size > MAX_IMAGE_BYTES) {
    throw new UserError(
      `${path} is ${(size / 1024 / 1024).toFixed(1)} MB as JPEG; Instagram's limit is 8 MB.`,
      "Resize or compress the image."
    );
  }
  if (opts.feed) {
    const problem = checkFeedImage(width, height);
    if (problem) throw new UserError(`${path}: ${problem}`);
  }
  return { path: out, width, height, converted: out !== path };
}

/** Uploads a local file and returns a public URL Instagram can fetch. */
export type Uploader = (file: string, contentType: string) => Promise<string>;

const R2_VARS = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET", "R2_PUBLIC_URL"];

function r2Uploader(env: NodeJS.ProcessEnv): Uploader {
  const missing = R2_VARS.filter((k) => !env[k]);
  if (missing.length) {
    throw new UserError(`R2 upload isn't configured: missing ${missing.join(", ")}.`, "Add them to .env (see docs/ig-cli.md), or pass public URLs instead of local files.");
  }
  const client = new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID!,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY!,
    service: "s3",
    region: "auto",
  });
  return async (file, contentType) => {
    const key = `ig/${Date.now()}-${randomBytes(4).toString("hex")}${extname(file).toLowerCase()}`;
    const res = await client.fetch(
      `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET}/${key}`,
      { method: "PUT", body: await readFile(file), headers: { "content-type": contentType } }
    );
    if (!res.ok) {
      throw new UserError(`R2 upload failed (HTTP ${res.status}): ${(await res.text()).slice(0, 300)}`, "Check the R2_* values in .env and that the API token can write to the bucket.");
    }
    return `${env.R2_PUBLIC_URL!.replace(/\/$/, "")}/${key}`;
  };
}

const UPLOADERS: Record<string, (env: NodeJS.ProcessEnv) => Uploader> = { r2: r2Uploader };

export function getUploader(env: NodeJS.ProcessEnv = process.env): Uploader {
  const name = env.IG_UPLOADER ?? "r2";
  const make = UPLOADERS[name];
  if (!make) throw new UserError(`Unknown IG_UPLOADER "${name}".`, `Use one of: ${Object.keys(UPLOADERS).join(", ")}.`);
  return make(env);
}

export const contentType = (file: string) =>
  ({ ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".mp4": "video/mp4", ".mov": "video/quicktime" })[
    extname(file).toLowerCase()
  ] ?? "application/octet-stream";
