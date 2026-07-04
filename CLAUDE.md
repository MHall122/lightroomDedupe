@AGENTS.md

# Lightroom Dedupe — session context

Self-hostable Next.js web app: users sign in with Adobe, scan their Lightroom cloud library for duplicates using perceptual hash + metadata, and add flagged photos to a Lightroom album they can then bulk-delete inside Lightroom.

**Repo:** https://github.com/MHall122/lightroomDedupe
**Owner:** mhall@acbmsolutions.com
**Local path:** `C:\Users\Ylem\projects\lightroom-dedupe`

## Stack

- Next.js 16.2.9 (App Router, Turbopack, HTTPS in dev via `--experimental-https` + mkcert)
- React 19
- TypeScript
- Tailwind CSS v4
- iron-session (encrypted cookie sessions — **no database, no server-side storage**)

Read [AGENTS.md](AGENTS.md) before writing route/proxy/config code — this Next.js has breaking changes from pre-16 training. Key gotchas already hit and fixed:
- `cookies()` is async — `await cookies()`
- `params` on route handlers is async — `await ctx.params`, and use `RouteContext<'/path/[id]'>` typed helper
- Middleware renamed to Proxy (`proxy.ts` with `proxy` export). Not currently used.

## Zero-storage model (this is load-bearing for Adobe partner review)

Nothing about the user's library persists server-side:

- **Auth tokens** live only in an encrypted cookie in the user's browser. The server decrypts the cookie per-request to make an Adobe API call, then drops the plaintext.
- **Photos / thumbnails** are proxied through the server on the way to the browser and never written to disk or memory beyond the fetch's own buffer.
- **Duplicate hashes and grouping results** live only in the browser tab. Reload = lost.
- **No database.** No user accounts, no persisted preferences (except a localStorage default-album key that lives client-side).

This is the honesty story we're selling in the Going Public section of the README. Don't quietly add server-side persistence without checking with the user first.

## Adobe partner API — hard limits discovered

These are architectural, not scope/permission issues. No amount of getting our OAuth "recognized" fixes them:

1. **DELETE `/catalogs/{cat}/assets/{id}` returns 403 code 1002** — the Lightroom Services partner API does not permit third-party apps to delete user photos, ever. Verified against Adobe's error responses. The workflow *has* to end with the user deleting inside Lightroom itself. Don't try to bypass this.
2. **Project albums (`subtype: "project"`)** are the only album subtype partner apps can create (attempts to create `subtype: "collection"` return input-validation errors). Project albums only surface in Lightroom's **Connections panel**, and only for apps Adobe has formally onboarded as recognized partners. For unrecognized apps (which this is), users literally cannot see the album — it exists server-side but no Lightroom UI shows it.
3. **Adding user-owned assets to a partner-created project album returns 403 code 1002** per-asset. Project albums are meant for content the partner *uploads* (think: printing service adds sample prints), not for organizing existing user content.

**Working solution to all three:** the user creates an empty user-owned album in Lightroom first, then picks it from the dropdown in the app. Writing to a user-owned album with the user's own OAuth token uses a different Adobe permission path and works cleanly. The app's "Destination album" picker is the surface for this.

## Match config — how duplicates get detected

`src/lib/dedupe-groups.ts` owns everything. `MatchConfig` has four criteria, each independently toggleable with a per-criterion tolerance, plus AND/OR logic to combine:

- **Visual similarity** — perceptual hash (dHash). Resolutions: 8/16/32/64 (grid is `N+1` wide × `N` tall, producing `N²` bits). Thresholds are percentage-based (10% for Strict, 20% for Loose) so tolerance scales automatically with resolution.
- **Filename** — exact, or "similar" (strip extension + trailing `-1`, `-copy`, `-edited`, `-final`, digits).
- **File size** — exact bytes, within 1%, or within 10%.
- **Capture time** — exact ISO string, within 10s / 60s / 1h.
- **AND** — pair matches only if every enabled criterion says yes. **OR** — any one suffices. Missing data (null captureDate, null fileName) silently skips that criterion for the pair rather than forcing a fail.

Grouping is union-find over the pairwise match matrix — this creates chain-effect false positives (A~B, B~C → {A,B,C} even if A and C don't match). Landscape photos are the worst offender because their compositions rhyme. Countermeasure: raise resolution or AND with capture-time.

Client-only hashing via `src/workers/hash.worker.ts`. Only fetches thumbnails when `needsThumbnails(config)` is true (i.e. visual criterion is on).

## Key files

- [src/components/Deduper.tsx](src/components/Deduper.tsx) — the whole client-side state machine (idle → scanning → reviewing → deleting → done), scope picker, match config UI, destination album picker, preview, review grid, CSV export.
- [src/lib/lightroom.ts](src/lib/lightroom.ts) — Adobe API client. Uses `toAdobeUrl()` to handle three URL shapes returned by Adobe: absolute URLs, `/v2/...` paths, and relative `assets?...` fragments (this last one is what Adobe's `next.href` pagination returns — resolve via `new URL(next.href, requestUrl)`).
- [src/lib/dedupe-groups.ts](src/lib/dedupe-groups.ts) — `MatchConfig`, `groupByConfig`, per-criterion match functions.
- [src/lib/dhash.ts](src/lib/dhash.ts) — perceptual hash, resolution-configurable, percentage-scaled Hamming.
- [src/lib/adobe-auth.ts](src/lib/adobe-auth.ts) — IMS OAuth 2.0 + PKCE. Scopes: `openid AdobeID offline_access lr_partner_apis lr_partner_rendition_apis`. Do NOT add `email` or `profile` — Adobe rejects those with `invalid_scope`.
- [src/lib/session.ts](src/lib/session.ts) — iron-session config.
- [src/app/api/auth/callback/adobe/route.ts](src/app/api/auth/callback/adobe/route.ts) — OAuth callback. Route lives at `/adobe` because that's what was registered in the Adobe developer console. Owner's console has this exact path.
- [src/app/api/lightroom/duplicates-album/route.ts](src/app/api/lightroom/duplicates-album/route.ts) — writes the flagged photos into the user-picked destination album. Pre-checks album contents via `listAlbumAssetIds` and filters out anything already there, so we get accurate "N added / M already in album" reporting.

## Current state (2026-07-02)

- Codebase compiles cleanly (`npx tsc --noEmit` exits 0 at session end).
- Repo pushed to https://github.com/MHall122/lightroomDedupe. Two commits: initial code drop + README.
- **Working end-to-end for the owner's own library** on `https://localhost:3000`:
  - OAuth sign-in works
  - Scope selection (all / album / year-month-day) works
  - Match config with all four criteria + AND/OR works
  - Preview matches works
  - Scan + review + add-to-user-album works
  - CSV export works as fallback
- **Not yet done:**
  - Not deployed anywhere yet — owner mentioned AWS Lightsail as the next step but hasn't started
  - Not submitted for Adobe partner production review
  - No privacy policy or terms of service pages
  - No screenshots in README

## Owner's stated intent

Publish source publicly (GitHub is already public) so anyone technical can self-host. Deploy their own instance eventually. Adobe partner approval is on the table but not yet started. Owner has other Node/Bitnami apps on Lightsail already (see workspace CLAUDE.md for the Caradence project on the same infra) so they know the deploy drill.

## Things not to do without checking

- Don't add server-side persistence (database, disk cache, session store). Zero-storage is the pitch.
- Don't try to make DELETE work — it's architecturally denied. If you find a clever workaround, sanity-check with owner first, don't just ship it.
- Don't switch back to project albums / `collection` subtype. Both fail; user-owned collection album is the working path.
- Don't add OpenID `email` / `profile` scopes to the Adobe scope list — they cause `invalid_scope` at the IMS authorize step.
- Don't change the callback path away from `/api/auth/callback/adobe` — owner's Adobe console registration uses that specific path.
- Don't add dark mode. `globals.css` explicitly opts out via `color-scheme: light` because owner's OS is in dark mode and it kept fighting the panel styles.

## Contrast pass done this session

Owner's OS is in dark mode. Multiple rounds of contrast bumps landed on:
- All non-heading text: explicit `text-zinc-900` on labels, `text-zinc-700` on descriptions, `text-zinc-600` for tertiary
- All `<select>` elements: explicit `text-zinc-900` because browser defaults render them muted
- Secondary buttons: explicit `bg-white text-zinc-900 border-zinc-400` — no more relying on inheritance
- Panel sections: added `text-zinc-900` on the outer `<section>` as a defensive parent-level color
- Disabled state: `opacity-60` instead of `opacity-40`
- Description text bumped from `text-xs` to `text-sm`
- Removed the `prefers-color-scheme: dark` CSS variable overrides in `globals.css` that were fighting Tailwind

If you're rebuilding the picker UI, mirror these patterns — don't drop back to unqualified `text-sm` for label text.
