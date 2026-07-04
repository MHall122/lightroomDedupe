# Lightroom Dedupe

A self-hostable web app that scans your Adobe Lightroom cloud library for duplicate photos and helps you clean them up.

## What it does

1. Sign in with your Adobe account
2. Scan your Lightroom cloud library (whole library, a specific album, or a date range)
3. Detect duplicates using any mix of: visual similarity (perceptual hash), filename, file size, and capture time — combined with AND/OR logic
4. Review side-by-side, tweak selections, and add the flagged photos to a Lightroom album of your choice
5. Open that album in Lightroom and bulk-delete

Adobe's public API doesn't let third-party apps delete photos on your behalf — the last step happens inside Lightroom itself. This app just gets the flagged photos into one place for you.

**Nothing is stored server-side.** Auth tokens live in an encrypted browser cookie. Thumbnails are hashed in a Web Worker and discarded. If the process dies, nothing about your library remains.

---

## Prerequisites

- **Node.js 20+** — grab it from [nodejs.org](https://nodejs.org)
- **mkcert** — for the local HTTPS cert (Adobe rejects `http://localhost` redirect URIs)
- **An Adobe account** — the same one you use for Lightroom
- Windows, macOS, or Linux — all work

### Installing mkcert

- **Windows (chocolatey):** `choco install mkcert`
- **macOS:** `brew install mkcert`
- **Linux:** see [mkcert docs](https://github.com/FiloSottile/mkcert#installation)

Then run **once as administrator**:

```
mkcert -install
```

This adds a local certificate authority to your system trust store. Next.js will use it to generate a valid HTTPS cert for `localhost:3000`.

---

## Adobe developer account setup

This is the biggest step. Adobe requires you to register your own developer app to use their Lightroom API. It's free and takes about 10 minutes.

### 1. Sign in to the Adobe developer console

Go to [developer.adobe.com/console](https://developer.adobe.com/console) and sign in with the same Adobe account you use for Lightroom.

### 2. Create a new project

Click **Create new project** → name it whatever (e.g. "Lightroom Dedupe"). You'll land on the empty project page.

### 3. Add the Lightroom Services API

Click **Add API** → search for and select **Lightroom Services API** → **Next**.

When it asks about authentication, choose **OAuth Web App** (not Service Account / JWT — those are server-to-server, we need user OAuth).

### 4. Configure OAuth

- **Redirect URI:** `https://localhost:3000/api/auth/callback/adobe`
- **Redirect URI pattern:** `https://localhost:3000/api/auth/callback/adobe`

For scopes, select:

- `openid`
- `AdobeID`
- `offline_access`
- `lr_partner_apis`
- `lr_partner_rendition_apis`

Click **Save configured API**.

### 5. Grab your credentials

On the project page, find the OAuth Web App credential you just created. Note down:

- **Client ID** (safe to share, it's public-ish)
- **Client Secret** — treat like a password, never commit this

### 6. Whitelist your Adobe email for dev mode

By default, only Adobe emails you explicitly whitelist can sign in to your app. On the project page, look for the **Users** or **Whitelist** section. Add the Adobe email you use for Lightroom.

You can add up to ~10 emails without any Adobe approval. Beyond that requires production API review — see [Going public](#going-public) below.

---

## Local setup

### 1. Clone this repo

```
git clone https://github.com/MHall122/lightroomDedupe.git
cd lightroomDedupe
```

### 2. Install dependencies

```
npm install
```

### 3. Create `.env.local`

Copy the template:

```
cp .env.local.example .env.local
```

Fill in the values you got from the Adobe console:

```
ADOBE_CLIENT_ID=<paste your client ID>
ADOBE_CLIENT_SECRET=<paste your client secret>
ADOBE_REDIRECT_URI=https://localhost:3000/api/auth/callback/adobe
SESSION_PASSWORD=<generate below>
```

Generate a random 32-byte session password:

```
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Paste the output into `SESSION_PASSWORD`.

### 4. Run it

```
npm run dev
```

The terminal should show `Local: https://localhost:3000`. Open that URL in a browser. Chrome will complain about the self-signed cert on first visit — click **Advanced → Proceed to localhost**. This warning only appears once.

Sign in with your (whitelisted) Adobe account. You'll land on the dashboard.

---

## Using the app

### 1. Create a destination album in Lightroom first

Before running your first scan, go to [lightroom.adobe.com](https://lightroom.adobe.com) (or open Lightroom desktop/mobile), and create an empty album — call it whatever you want, e.g. "Duplicates". This is where flagged duplicates will land. Wait ~30 seconds for it to sync.

### 2. Set up your scan

On the dashboard:

- **What to scan** — start small. "By date" for one specific day is a good first test.
- **How to match** — turn on any combination. For strict de-dupe, try **Visual similarity (Strict, Precise 32×32)**. For burst-mode cleanup, add **Capture time (within 10 seconds)** with **AND**.
- **Destination album** — pick the album you created in step 1. It's remembered for next time.

### 3. Preview

Click **Preview matches** to see the first batch of photos that fall in your scope, without hashing them. Good sanity check.

### 4. Scan and review

Click **Start scan**. The scan pages through your library, downloads a small thumbnail per photo, hashes each in a Web Worker, and groups duplicates. Progress shows live.

When it's done, you land in the review UI. Each duplicate group shows all its photos side-by-side:

- **Green "Keep" badge** — the highest-resolution photo in the group (auto-suggested)
- **Red "Trash" badge** — pre-selected for adding to the album
- **Blue "In album" badge** — already in your destination album from a previous run

Check/uncheck any photo to override. Then click **Add N to Lightroom album**.

### 5. Finish in Lightroom

Open Lightroom. Go to your destination album. Select all (Ctrl+A / ⌘+A). Delete. Done.

Photos go to Lightroom's trash and are recoverable for 60 days if you change your mind.

---

## How the matching works

- **Visual similarity** uses a [difference hash (dHash)](https://www.hackerfactor.com/blog/index.php?/archives/529-Kind-of-Like-That.html). Photos are downsized to a small grayscale grid (8×8 up to 64×64, configurable), and adjacent-pixel comparisons produce a fingerprint. Two fingerprints match if their Hamming distance is under a percentage threshold (10% for Strict, 20% for Loose). Higher resolution = more discriminating.
- **Filename similar** strips extensions and trailing suffixes like `-1`, `-copy`, `-edited` before comparing. So `IMG_1234.jpg`, `IMG_1234-1.jpg`, and `IMG_1234-copy.jpg` all match.
- **File size within N%** compares byte sizes with a tolerance. Within 1% catches re-encodes; 10% catches heavier edits.
- **Capture time within N seconds** compares EXIF timestamps. Within 10s catches burst-mode. Within 1h catches "same shoot."
- **AND** requires all enabled criteria to match for a pair to be grouped. **OR** requires any one.

---

## Limitations

### 1. Delete isn't automated

Adobe's public partner API doesn't allow third-party apps to delete photos from Lightroom. This is a hard architectural limit, not a permissions issue. Every dedupe tool of this style has to work the same way: prepare the list, hand off to Lightroom for the actual delete.

### 2. Dev-mode whitelist

Without Adobe production API approval, only the emails you explicitly whitelist in your developer console can sign in. Up to ~10 emails.

### 3. Album must be user-owned

The app can't create user-visible albums on your behalf (Adobe's partner API only lets us create "project" albums, which don't show in Lightroom's UI unless you're a formally-approved Adobe partner). Workaround: you create the empty album in Lightroom first, and pick it from the dropdown in the app.

### 4. Perceptual hash isn't perfect for landscape photos

Photos with similar overall composition (e.g. multiple lake shots at the same horizon line) can group together even when they're different scenes. Countermeasures: use higher resolution (Precise 32×32 or Extreme 64×64), combine visual with capture-time AND, or use a tighter tolerance.

---

## Going public

If you want other people (beyond your whitelisted testers) to use your deployment, you need Adobe's production API approval.

Rough process:

1. Deploy the app to a real HTTPS domain (Vercel free tier, AWS Lightsail, or any Node host)
2. Add the production redirect URI in the Adobe console
3. Write a one-page privacy policy and terms-of-service (this app makes them very short — you store nothing)
4. Submit for partner review at developer.adobe.com
5. Wait 2–6 weeks

Adobe's review is genuinely selective. The "zero server-side storage, free tool" story helps — you can be honest that you're not a data processor for anyone else's photos. But approval isn't guaranteed, and even if approved, the delete endpoint stays off-limits (the album workflow is the ceiling).

---

## Development

Stack:

- **Next.js 16** (App Router, Turbopack)
- **TypeScript**
- **Tailwind CSS v4**
- **iron-session** — encrypted cookie sessions, no DB

Project layout:

```
src/
├── app/
│   ├── layout.tsx           # root layout
│   ├── page.tsx             # landing / login
│   ├── dashboard/           # gated, mounts <Deduper>
│   └── api/
│       ├── auth/            # OAuth: login, callback, logout
│       └── lightroom/       # proxied Adobe API
├── components/
│   └── Deduper.tsx          # the whole scan+review+submit flow
├── lib/
│   ├── env.ts
│   ├── session.ts
│   ├── adobe-auth.ts        # IMS OAuth
│   ├── lightroom.ts         # LR API client with auto-refresh
│   ├── dhash.ts             # perceptual hash
│   └── dedupe-groups.ts     # grouping / match config
└── workers/
    └── hash.worker.ts       # web worker wrapping computeDHash
```

Commands:

- `npm run dev` — dev server on `https://localhost:3000`
- `npm run build` — production build
- `npm start` — run the production build (used in real deployments, behind nginx/Apache with a real cert)
- `npx tsc --noEmit` — type-check without building

---

## Contributing

PRs welcome — open an issue first if it's a substantial change. Priorities:

- Better UX for landscape-photo false positives
- A byte-hash criterion (SHA256 of thumbnail bytes) for exact-image detection
- Persistence layer so hashes survive across sessions
- Rotation-invariant hashing (pHash / block-mean)

---

## License

MIT — do whatever you want.
