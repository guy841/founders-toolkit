# Shipping Helm to the App Store

This is the step-by-step to turn the Helm web app into a native iOS app and publish it.
The web app lives at the repo root (`../index.html` + `../tools/`); this `app/` folder wraps
it in a native shell using **Capacitor**. The same setup adds **Android** later with one command.

> **Where you are now:** the Capacitor project is scaffolded and the web bundle syncs into
> `app/www`. What remains needs a Mac with full Xcode — which this machine doesn't have yet.

---

## 0. One-time prerequisites

| Need | How | Cost |
|------|-----|------|
| **Apple Developer Program** | Enrol at [developer.apple.com/programs](https://developer.apple.com/programs/) with your Apple ID. Enrol as **Tree Top Capital Ltd** (you'll need the company's details / D-U-N-S number for an organisation account, or enrol as an individual to start). | **£79/year** |
| **Full Xcode** | Install from the **Mac App Store** (~10 GB). This machine currently only has Command Line Tools. | Free |
| **Point the toolchain at Xcode** | `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer` then `sudo xcodebuild -license accept` | — |
| **CocoaPods** | `brew install cocoapods` (Homebrew is already installed) | Free |

---

## 1. Generate the iOS project

```bash
cd app
npm install            # already done, but safe to re-run
npm run add:ios        # copies the web app into www/ and runs `cap add ios`
```

This creates `app/ios/` — a real Xcode project. (`app/.gitignore` ignores it by default;
delete the `ios/` line if you'd rather version it.)

## 2. Make the app icon

The icon source is `app/resources/icon.svg` (the helm mark on moss). Apple needs a 1024×1024 PNG:

```bash
# easiest: install librsvg once, then convert
brew install librsvg
rsvg-convert -w 1024 -h 1024 resources/icon.svg -o resources/icon.png
# (or just open icon.svg in Preview and File ▸ Export as PNG at 1024×1024)

npm run icons          # capacitor-assets generates every iOS icon size from icon.png
```

## 3. Open in Xcode and configure signing

```bash
npm run open:ios       # re-syncs the web bundle and opens ios/App/App.xcworkspace
```

In Xcode, select the **App** target ▸ **Signing & Capabilities**:

- **Team:** your Apple Developer team (Tree Top Capital Ltd).
- **Bundle Identifier:** `capital.treetop.helm` (already set in `capacitor.config.json`).
- Let Xcode "Automatically manage signing".
- **General ▸ Minimum Deployments:** iOS 14 or 15 is a safe floor.
- Set **Version** `1.0` and **Build** `1`.

## 4. Create the App Store listing

At [appstoreconnect.apple.com](https://appstoreconnect.apple.com) ▸ **Apps ▸ +**:

- **Name:** Helm — *(if "Helm" is taken, try "Helm: Director's Toolkit" or "Helm for Directors")*
- **Primary language:** English (U.K.)
- **Bundle ID:** `capital.treetop.helm`
- **Category:** Finance (or Business)
- **Privacy Policy URL:** `https://guy841.github.io/founders-toolkit/privacy.html`
- **Support URL:** `https://guy841.github.io/founders-toolkit/`
- **App Privacy:** choose **"Data Not Collected"** — Helm stores everything on-device. (No tracking, no analytics.)
- **Screenshots:** required for 6.7" and 6.5" iPhones. Easiest: run the app in the Xcode Simulator (iPhone 15 Pro Max), take screenshots of 3–5 tools (`Cmd+S` in Simulator).
- **Description / keywords:** sell the tools — deadlines, Corporation Tax, salary vs dividends, VAT, company records. Keywords like *UK, limited company, director, corporation tax, VAT, dividends, deadlines*.

## 5. Upload and submit

In Xcode: **Product ▸ Archive** ▸ when the Organizer opens, **Distribute App ▸ App Store Connect ▸ Upload**.

Then in App Store Connect:
- The build appears under **TestFlight** after processing (a few minutes). Test it on your own iPhone via TestFlight first.
- Attach the build to your **1.0** version, fill in the review notes, and **Submit for Review**.
- **Review notes to include:** *"Helm is a local-first utility for UK company directors. No account or login is required and no data is collected — everything the user enters is stored only on their device."* This pre-empts the usual questions.

Apple review typically takes **24–48 hours**.

---

## App Store Connect questionnaires — the answers for Helm

These trip people up; here's how Helm should be answered:

- **Encryption / Export Compliance.** App Store Connect asks "Does your app use encryption?" Helm uses **standard encryption only** — HTTPS, and AES‑256 (via the system's Web Crypto) for the *optional* Company Records passphrase. That is **exempt** encryption (data protection with standard algorithms). To answer it once and avoid the prompt on every upload, add this to `ios/App/App/Info.plist`:
  ```xml
  <key>ITSAppUsesNonExemptEncryption</key>
  <false/>
  ```
  In the App Store Connect prompt, choose **"uses exempt encryption."** *(If you're ever unsure for a future version, confirm against Apple's export-compliance docs — but standard AES for local data protection is exempt.)*
- **App Privacy ("nutrition label").** Select **Data Not Collected** — Helm stores everything on-device, has no accounts, no analytics and no ads.
- **Age rating.** All "None" → **4+**.
- **Sign in with Apple.** Not required for v1 — Helm has **no login at all**. (It only becomes required once you add any third-party/email sign-in, i.e. in the accounts fast-follow.)
- **Content rights.** You own/are licensed for all content.

The full listing copy (name, subtitle, description, keywords) is in **`store-listing.md`** next to this file.

## Updating the app later

The web app is the single source of truth. After editing anything at the repo root:

```bash
cd app
npm run build          # sync:web + cap sync  (pushes web changes into the native app)
npm run open:ios       # archive a new build (bump Build number) and upload
```

The website (GitHub Pages) updates automatically on `git push`; the app updates when you ship a new build.

## Cloud build — publish without installing Xcode locally

If you don't want the ~12 GB local Xcode, build on a hosted macOS machine instead. A
workflow is already in the repo: **`.github/workflows/ios.yml`** (manual trigger only,
so it never eats your Actions minutes by surprise).

- **Smoke build (works today, no Apple account):** GitHub ▸ **Actions** ▸ "iOS build" ▸
  **Run workflow** ▸ mode `smoke`. It generates the iOS project and compiles it unsigned
  on a macOS runner — a quick way to confirm the app builds. *(macOS minutes count ~10×,
  so a run is ~5–10 min of your monthly allowance.)*
- **Release (signed + TestFlight):** once Apple enrolment is done, add these **repo
  secrets** (Settings ▸ Secrets ▸ Actions), then run the workflow with mode `release`:
  - `APPSTORE_ISSUER_ID`, `APPSTORE_KEY_ID`, `APPSTORE_PRIVATE_KEY` — an **App Store
    Connect API key** (App Store Connect ▸ Users and Access ▸ Integrations ▸ App Store
    Connect API ▸ generate a key; download the `.p8`). No Xcode needed to make this.
  - `BUILD_CERT_P12_BASE64`, `BUILD_CERT_PASSWORD`, `PROVISION_PROFILE_BASE64` — your
    **iOS Distribution certificate** and **provisioning profile**. Easiest way to create
    these without Xcode is `fastlane match` or the Apple Developer portal.

A starter **fastlane** lane is in `app/fastlane/Fastfile` (`beta` = build + upload to
TestFlight using the API key). When your secrets are in place, swap the placeholder
"Archive + upload" step in the workflow for `cd app && bundle exec fastlane beta`.

> Alternative: **Codemagic** has a Capacitor template with a UI that manages signing for
> you — often the least-fuss way to ship from a non-Mac-Xcode setup. Same Apple account
> and API key required.

## Adding Android later

```bash
npm install @capacitor/android
npm run sync:web && npx cap add android
npx cap open android   # build/submit via Android Studio + a Google Play account (£20 one-off)
```

## Roadmap: optional accounts + sync (the fast-follow)

When you're ready for "create an account, your data syncs everywhere":

- **Backend:** Supabase (EU region) — Auth + Postgres with row-level security so each user only sees their own rows. Add **Sign in with Apple** (required by App Store rule 4.8 if any sign-in is offered).
- **Model:** keep it **local-first** — the app works with no account exactly as now; signing in *additionally* saves Company Records (and checklist/insurance progress) to the user's private rows and syncs across iOS, web and Android.
- **What changes in code:** Company Records' storage layer swaps `localStorage` for "localStorage + sync to Supabase when signed in." The tools themselves don't change.
- **Then update** `privacy.html` to describe what's stored server-side and how to delete it.

---

### Quick reference — npm scripts in this folder

| Script | What it does |
|--------|--------------|
| `npm run sync:web` | Copy `../index.html` + `../tools/` into `app/www` |
| `npm run add:ios` | sync web, then generate the iOS project |
| `npm run open:ios` | sync web, `cap sync`, open Xcode |
| `npm run icons` | generate iOS app icons from `resources/icon.png` |
| `npm run build` | sync web + `cap sync` (after web edits) |

*Set your support/contact email in `privacy.html` (currently `hello@treetop.capital`) before submitting.*
