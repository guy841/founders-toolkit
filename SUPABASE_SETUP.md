# Helm accounts & sync — one-time Supabase setup

Helm's web tools work fully offline with no account. The optional **account +
cross-device sync** layer needs a tiny backend. We use [Supabase](https://supabase.com)
(hosted Postgres + auth). This is the only manual step — once the two keys are in
`helm-config.js`, sign-in/sync goes live for everyone.

The design is **end-to-end encrypted**: a user's data is encrypted in their
browser with a key derived from their password, and the server only ever stores
ciphertext. Supabase (and we) cannot read it. See `helm-sync.js` header for the
crypto details.

---

## 1. Create the project (~3 min)

1. Sign in at <https://supabase.com> → **New project**.
2. Name it `helm` (or anything), pick a strong DB password (save it in your
   password manager — you won't need it for Helm), and choose a region close to
   your users (e.g. **London / eu-west-2** for the UK).
3. Wait for it to finish provisioning.

## 2. Create the table + security rules

1. Left sidebar → **SQL Editor** → **New query**.
2. Paste the entire contents of [`supabase/schema.sql`](supabase/schema.sql) and
   click **Run**. You should see "Success". This creates the `vaults` table,
   turns on Row-Level Security with owner-only policies, and adds a
   `delete_my_account()` function.

## 3. Auth settings

Go to **Authentication → Providers → Email** and **Sign In / Providers**:

- **Email** provider: enabled (default).
- **Confirm email**: your call —
  - **ON (recommended for production):** users must click an emailed link before
    they can sign in. Most secure. Requires email delivery to work (see step 4).
    Helm handles this — after sign-up it shows "Check your email".
  - **OFF (frictionless):** users can sign in immediately after sign-up. Fine for
    early testing. Turn it on before you promote the site widely.

Under **Authentication → URL Configuration**, set **Site URL** to
`https://helm.treetop.capital` and add it (and `http://localhost:*` if you test
locally) to **Redirect URLs**.

> **Important — do not advertise password reset.** Helm is end-to-end encrypted:
> the password *is* the decryption key. Supabase's built-in "reset password"
> would change the login password but orphan the encrypted data. Helm therefore
> never links to Supabase's reset flow; users rotate their password from inside
> the app (**Account → Change password**), which re-encrypts their data. Leave
> the reset email template alone / unused.

## 4. Email delivery (only if "Confirm email" is ON)

Supabase's built-in email sender is rate-limited and meant for testing. For real
use, add an SMTP provider under **Authentication → Emails → SMTP Settings**
(e.g. Resend, Postmark, SES, or your Google Workspace SMTP). Set the "from"
address to something like `hello@treetop.capital`.

## 5. Wire up Helm

1. **Project Settings → API.** Copy:
   - **Project URL** (e.g. `https://abcdefgh.supabase.co`)
   - **anon / public** key (the long JWT under "Project API keys")
2. Open [`helm-config.js`](helm-config.js) and paste both values:
   ```js
   window.HELM_CONFIG = {
     SUPABASE_URL: "https://abcdefgh.supabase.co",
     SUPABASE_ANON_KEY: "eyJhbGciOi...",
   };
   ```
   These are **safe to commit and ship** — the anon key grants nothing without a
   valid signed-in session, and all access is gated by Row-Level Security.
3. Bump the service-worker cache version so clients pick up the change: in
   `sw.js`, change `const CACHE = "helm-vN"` to the next number.
4. Commit + push. GitHub Pages redeploys; the **Sign in** pill goes live.

## 6. Verify

On the live site (or any https host):

1. Click **Sign in → Create an account**, use a real email + a password.
2. Open **Company Records**, save some details.
3. Open the site in another browser/device, sign in with the same credentials —
   your records appear. Edit on one device; the other reflects it on next load.
4. **Account → Change password** should keep your data intact.

## Notes & limits (v1)

- **Conflict policy:** last-write-wins on the whole encrypted snapshot, with a
  `helm:sync:conflict-backup` left in localStorage if both sides changed offline.
- **Per-tab unlock:** the encryption key is cached in `sessionStorage` so you can
  move between tool pages in one tab without re-entering your password; opening a
  brand-new tab asks you to unlock once. It is never written to disk.
- **Shared browsers:** local data is tagged with the owning account. Signing in
  or signing up evicts any other account's leftover data, signing out wipes this
  device's copy, and no plaintext backup is left behind — so one person's details
  can't surface in the next person's session.
- **Recovery:** none, by design. A forgotten password means unrecoverable data.
  This is the price of true end-to-end encryption and is stated clearly in the UI.
- **Cost:** comfortably within Supabase's free tier for this workload (one small
  row per user, occasional reads/writes).
