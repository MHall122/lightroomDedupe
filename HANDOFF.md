# Lightroom Dedupe — Session Handoff

Standalone Next.js web app that lets a user sign in to Adobe with OAuth, scans their Lightroom cloud library for near-duplicate photos using perceptual hashing (dHash), and moves selected duplicates to Lightroom's trash (60-day recoverable).

**Owner:** mhall@acbmsolutions.com
**Repo location:** `C:\Users\Ylem\projects\lightroom-dedupe`
**Stack:** Next.js 16.2.9 (App Router, Turbopack), React 19, TypeScript, Tailwind v4, iron-session (encrypted cookie sessions — no DB).

---

## Environment

- Windows 11, Node v25.8.1, npm 11.11.0.
- Next.js 16 has breaking changes from pre-16 training data. See `AGENTS.md` — read `node_modules/next/dist/docs/` before writing any new route/proxy/config code. Key gotchas hit so far:
  - `cookies()` is async — `await cookies()`.
  - Route handler `params` is async — `await ctx.params`. Use `RouteContext<'/path/[id]'>` (globally available after `next typegen`, `next dev`, or `next build`).
  - Middleware is now called **Proxy** (`proxy.ts` with `proxy` export). Not currently used in this app.

---

## Current status

- Production build passes cleanly (`npx next build` → 0 errors).
- `tsc --noEmit` passes.
- **Not yet smoke-tested against real Adobe API** — owner is still setting up the developer account. The API shape assumptions in [src/lib/lightroom.ts](src/lib/lightroom.ts) (pagination via `body.links.next.href`, rendition sizes, `while (1) {}` anti-hijacking prefix, "me" catalog via `00000000000000000000000000000000`) are based on Adobe's docs and are unverified in this project.

---

## What was built

### Auth (Adobe IMS OAuth 2.0 + PKCE)
- [src/lib/adobe-auth.ts](src/lib/adobe-auth.ts) — authorize URL builder, PKCE code verifier/challenge, code→token exchange, refresh, id_token decode.
- Scopes: `openid email profile offline_access lr_partner_apis lr_partner_rendition_apis`.
- IMS base: `https://ims-na1.adobelogin.com` (endpoints `/ims/authorize/v2` and `/ims/token/v3`).
- [src/lib/session.ts](src/lib/session.ts) — iron-session-backed encrypted cookie. Stores Adobe access + refresh tokens plus PKCE state during OAuth. No database.
- Routes: [/api/auth/login](src/app/api/auth/login/route.ts), [/api/auth/callback](src/app/api/auth/callback/route.ts), [/api/auth/logout](src/app/api/auth/logout/route.ts).

### Lightroom API client
- [src/lib/lightroom.ts](src/lib/lightroom.ts) — base URL `https://lr.adobe.io/v2`. Every call sends `Authorization: Bearer <token>` + `X-API-Key: <client_id>`. `ensureAccessToken()` refreshes if within 60s of expiry.
- Handles Adobe's `while (1) {}` JSON prefix (yes, they still use it).
- Proxied to browser via:
  - [/api/lightroom/me](src/app/api/lightroom/me/route.ts) — account + catalog
  - [/api/lightroom/assets](src/app/api/lightroom/assets/route.ts) — paginated asset list (`?after=<next path>`)
  - [/api/lightroom/assets/[id]/thumbnail](src/app/api/lightroom/assets/[id]/thumbnail/route.ts) — streams rendition (default size 640)
  - [/api/lightroom/assets/[id]](src/app/api/lightroom/assets/[id]/route.ts) — DELETE (moves to trash)

### Duplicate detection
- [src/lib/dhash.ts](src/lib/dhash.ts) — 9×8 grayscale difference hash, 64-bit output as 16-char hex. Uses `createImageBitmap(blob, {resizeWidth,resizeHeight})` + `OffscreenCanvas`.
- [src/workers/hash.worker.ts](src/workers/hash.worker.ts) — one Web Worker consumed via `new Worker(new URL('...', import.meta.url), {type:'module'})`.
- [src/lib/dedupe-groups.ts](src/lib/dedupe-groups.ts) — union-find grouping over Hamming distance ≤ 6. Groups sorted by size; items within a group ranked by pixel count then file size so the "best" one is first (pre-selected as Keep).

### UI
- [src/app/page.tsx](src/app/page.tsx) — landing (redirects to /dashboard if signed in). Shows OAuth error messages via `?error=` query.
- [src/app/dashboard/page.tsx](src/app/dashboard/page.tsx) — server component that gates on session and mounts `<Deduper>`.
- [src/components/Deduper.tsx](src/components/Deduper.tsx) — the whole workflow client-side, state machine: `idle → scanning → reviewing → deleting → done`. Fetches assets 200 at a time; hashes 4 in parallel; delete uses concurrency 3. Best-quality item in each group is pre-marked "Keep", others pre-selected for trash — user can toggle any.

---

## How to run

1. Ensure [.env.local](.env.local) has real values. Owner has already filled in `ADOBE_CLIENT_ID` and `ADOBE_CLIENT_SECRET`.
2. **`SESSION_PASSWORD` is still the placeholder** — generate a real one before running:
   ```
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
   and paste into `.env.local`.
3. `npm run dev` — starts on **https://localhost:3000** (self-signed cert via `next dev --experimental-https`). Browser will warn about the cert; accept it once.
4. Adobe developer console redirect URI must be **`https://localhost:3000/api/auth/callback`** (Adobe rejects `http` on localhost for their web-app OAuth clients — this bit the owner during setup).

---

## Open questions / verify on first real run

These are best-effort based on Adobe docs. Fix as we find divergence:

1. **Asset pagination shape** — code reads `body.links.next.href`. If Adobe uses a different key (`base` + `next_url`, or `Link` header only), adjust `listAssets()` in [src/lib/lightroom.ts](src/lib/lightroom.ts#L110).
2. **`640` rendition availability** — code assumes the 640px rendition exists for every synced photo. If some return 404, the scan currently just counts them as `failed` and skips. If most fail we may need to try `thumbnail2x` (~150px, less reliable for hashing but faster) or `1280` as fallback.
3. **Delete endpoint semantics** — code does `DELETE /catalogs/{cat}/assets/{id}`. Adobe docs describe this as moving to trash. Verify that behavior; if it hard-deletes, we need to warn users differently.
4. **`catalogs/00…0` and `accounts/00…0`** — the all-zeros "me" ID convention. Documented, but worth confirming the first response isn't a 404.

---

## Design decisions worth preserving

- **No database.** All state is either in the encrypted cookie (Adobe tokens) or in the browser during a scan session. This dramatically shrinks the security/compliance surface and works fine for a single-tenant-per-cookie model.
- **Thumbnails proxied through this app, not linked directly.** Adobe rendition URLs require the bearer token in a header, so a plain `<img src="https://lr.adobe.io/…">` doesn't work. `/api/lightroom/assets/[id]/thumbnail` proxies with `Cache-Control: private, max-age=3600` so the browser caches during the scan.
- **Hashing in a Web Worker with OffscreenCanvas.** Keeps the main thread responsive. One worker + parallel fetches is intentional (see FETCH_CONCURRENCY = 4). Don't add more workers without profiling — the bottleneck is network, not hashing.
- **dHash over a "real AI" embedding.** Faster, deterministic, catches true duplicates and near-duplicates (light crops, minor edits) well. If we later want burst-mode/similar-scene detection, add a second pass with CLIP embeddings on the smaller candidate set that survives dHash.
- **Best-photo-kept default.** In each group, the item with the most pixels (falling back to file size) is pre-marked Keep and all others pre-selected for trash. Owner explicitly asked for a review UI, so this is a suggestion — user can override any selection.

---

## Not built yet (Phase 2)

Owner's stated goal is that "anyone can log in with their own Adobe account." That requires:

1. **Adobe production API review** (2–6 weeks). Currently we're in dev mode: only Adobe emails explicitly whitelisted in the developer console can sign in.
2. **HTTPS on a real domain** with a real cert — needed for the production OAuth redirect URI. Add the prod URL to the Adobe console's redirect URI list alongside the localhost one.
3. **Privacy policy + Terms of Service URLs** — Adobe asks for these during production review. Owner is a data processor for other users' photo libraries.
4. **Hosting** — Vercel recommended (Next.js first-party). Free tier handles low traffic; add Supabase or Neon only if we need to persist hashes across sessions for large libraries.

---

## Files worth knowing about

```
src/
├── app/
│   ├── layout.tsx           # root layout
│   ├── page.tsx             # landing / login
│   ├── dashboard/page.tsx   # gated, mounts <Deduper>
│   └── api/
│       ├── auth/            # OAuth: login, callback, logout
│       └── lightroom/       # proxied Adobe API: me, assets, [id], [id]/thumbnail
├── components/
│   └── Deduper.tsx          # the whole scan+review+delete flow (client component)
├── lib/
│   ├── env.ts               # required-env-var helpers
│   ├── session.ts           # iron-session config
│   ├── adobe-auth.ts        # IMS OAuth flow
│   ├── lightroom.ts         # LR API client with auto-refresh
│   ├── dhash.ts             # perceptual hash (runs in worker)
│   └── dedupe-groups.ts     # union-find grouping
└── workers/
    └── hash.worker.ts       # web worker wrapping computeDHash
```

---

## Immediate next step when this session picks up

Owner finishes Adobe dev account setup → drops `ADOBE_CLIENT_ID` / `ADOBE_CLIENT_SECRET` into `.env.local` (already done) → generates `SESSION_PASSWORD` → runs `npm run dev` → tries signing in. First scan against the owner's real library will surface the "open questions" above. Fix as they show up.
