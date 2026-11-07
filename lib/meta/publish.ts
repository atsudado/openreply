import { getMetaGraphApiVersion } from "@/lib/env";
import { handleResponse } from "@/lib/meta/client";

// Content Publishing API (Instagram Login): container -> wait FINISHED -> media_publish.

type Params = Record<string, string | undefined>;

async function call<T>(
  token: string,
  method: "GET" | "POST",
  path: string,
  params: Params = {}
): Promise<T> {
  const url = new URL(`https://graph.instagram.com/${getMetaGraphApiVersion()}/${path}`);
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) (method === "GET" ? url.searchParams : body).set(k, v);
  }
  const response = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}` },
    body: method === "POST" ? body : undefined,
  });
  return handleResponse<T>(response);
}

export interface Account {
  user_id: string;
  username: string;
  name?: string;
  account_type?: string;
}

export const getAccount = (token: string) =>
  call<Account>(token, "GET", "me", { fields: "user_id,username,name,account_type" });

export const createContainer = (token: string, igUserId: string, params: Params) =>
  call<{ id: string }>(token, "POST", `${igUserId}/media`, params).then((r) => r.id);

export async function waitUntilFinished(
  token: string,
  containerId: string,
  opts: { timeoutMs?: number; intervalMs?: number; onStatus?: (status: string, elapsedMs: number) => void } = {}
): Promise<void> {
  const { timeoutMs = 300_000, intervalMs = 3_000, onStatus } = opts;
  const start = Date.now();
  for (;;) {
    const { status_code, status } = await call<{ status_code: string; status?: string }>(
      token,
      "GET",
      containerId,
      { fields: "status_code,status" }
    );
    const elapsed = Date.now() - start;
    onStatus?.(status_code, elapsed);
    if (status_code === "FINISHED" || status_code === "PUBLISHED") return;
    if (status_code === "ERROR" || status_code === "EXPIRED") {
      throw new Error(
        `Instagram could not process the media (${status_code}${status ? `: ${status}` : ""}). ` +
          "Check it meets Instagram's specs (images: JPEG under 8 MB; video: MP4/MOV, H.264, AAC) and try again."
      );
    }
    if (elapsed >= timeoutMs) {
      throw new Error(
        `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for Instagram to process the media ` +
          `(last status: ${status_code}). Large videos can take longer; retry with a higher --timeout.`
      );
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

export const publishContainer = (token: string, igUserId: string, containerId: string) =>
  call<{ id: string }>(token, "POST", `${igUserId}/media_publish`, { creation_id: containerId }).then(
    (r) => r.id
  );

export const getPermalink = (token: string, mediaId: string) =>
  call<{ permalink?: string }>(token, "GET", mediaId, { fields: "permalink" }).then((r) => r.permalink);

export interface Quota {
  quota_usage: number;
  config?: { quota_total: number; quota_duration: number };
}

export const getQuota = (token: string, igUserId: string) =>
  call<{ data: Quota[] }>(token, "GET", `${igUserId}/content_publishing_limit`, {
    fields: "quota_usage,config",
  }).then((r) => r.data[0]);
