# `ig`: publish to Instagram from the command line

A small CLI for posting to the Instagram professional account behind OpenReply's Meta app.
It uses the Content Publishing API with **Instagram Login** (`graph.instagram.com`) and reuses
`lib/meta/client.ts` for error handling. The API version is the shared `META_GRAPH_API_VERSION`
setting (`lib/env.ts`).

## Setup

1. **Permission.** The app needs `instagram_business_content_publish`
   (Meta dashboard → OpenReply → Use cases → Instagram API → Permissions and features).
2. **Token.** Use cases → Instagram API → API setup with Instagram login → *Generate token*.
   Dashboard tokens last 60 days.
3. **Cloudflare R2**, for local files. Instagram fetches media from a public URL, and Instagram Login has
   no direct upload, so local images and videos are uploaded to R2 first.
   - R2 → Create bucket. In its Settings, turn on public access (r2.dev subdomain or a custom domain).
   - R2 → Manage API tokens → Create token with *Object Read & Write* on that bucket.
   - Optional: add a lifecycle rule that deletes `ig/` objects after a few days. The CLI doesn't delete them.
4. Put everything in `openreply/.env`, which is git-ignored and never printed:

   ```
   IG_ACCESS_TOKEN=...
   R2_ACCOUNT_ID=...
   R2_ACCESS_KEY_ID=...
   R2_SECRET_ACCESS_KEY=...
   R2_BUCKET=...
   R2_PUBLIC_URL=https://pub-xxxx.r2.dev
   ```

5. Add a shell alias so `ig` works from any folder:

   ```bash
   # --tsconfig lets the `@/` imports resolve when you run ig from another folder
   alias ig="$HOME/Desktop/openreply/node_modules/.bin/tsx --tsconfig $HOME/Desktop/openreply/tsconfig.json $HOME/Desktop/openreply/cli/ig.ts"
   ```

## Keeping the token alive

Instagram tokens last 60 days. `ig refresh-token` renews it for another 60 days and saves it to `.env`.
Meta only renews a token that's at least a day old and hasn't expired yet.
`ig whoami` shows how many days are left.

To renew it automatically every week, use a launchd job (`~/Library/LaunchAgents/com.tryautom.ig-refresh-token.plist`). It runs
`ig refresh-token` every Monday at 10:00 and shows a macOS notification if renewal fails. The first run may ask
for permission for `node` to read the Desktop folder. An expired token can't be renewed: generate a new one in the
Meta dashboard (see Setup).

## Examples

```bash
ig whoami
ig quota
ig post photo.heic --caption "New drop #fashion"        # HEIC/PNG/WebP converted to JPEG
ig carousel 1.jpg 2.jpg clip.mp4 --caption "Lookbook"   # 2-10 items
ig reel video.mp4 --caption "BTS" --cover cover.jpg --share-to-feed
ig reel video.mp4 --caption "Test" --trial manual            # trial reel: non-followers first; graduate it in the app
ig reel video.mp4 --trial auto                            # Instagram graduates it if it performs well
ig story https://example.com/story.jpg
ig post photo.jpg --caption "test" --dry-run            # validates; uploads and creates nothing
ig post photo.jpg --caption "go" --yes --json           # no prompt, machine-readable output
```

Every command accepts `--json`. Success prints `{"ok":true,...}` and failure prints
`{"ok":false,"error":"...","fix":"...","detail":"<Meta's message>"}` with exit code 1.
Posting commands ask for confirmation unless you pass `--yes`. Without a terminal they refuse to post unless `--yes` is given.

## Checks before calling the API

- Caption: 2,200 characters, 30 hashtags, 20 @mentions.
- Feed images (`post`, `carousel`): aspect ratio 4:5 to 1.91:1, at least 320px wide, 8 MB or less after JPEG conversion.
- Local files only. For URLs, Instagram does the checking and the CLI explains its errors.
- Video specs aren't checked locally. Instagram reports problems while processing, and the CLI waits up to `--timeout` seconds (default 300).

## Code

- `cli/ig.ts`: entry point. Loads `.env` and wires up the prompt.
- `cli/commands.ts`: commands, the publishing flow, and plain-English Meta errors.
- `cli/media.ts`: validation, conversion (macOS `sips`), and the uploader (`IG_UPLOADER`, default `r2`; add another entry to `UPLOADERS` to switch hosts).
- `lib/meta/publish.ts`: Content Publishing API calls.
- Tests: `__tests__/ig-cli.test.ts` (HTTP mocked).
