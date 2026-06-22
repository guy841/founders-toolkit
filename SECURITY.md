# Security

Helm is a set of static, client-side tools for UK company directors. By default
everything runs on the user's device with no network calls. The optional account
sync is **end-to-end encrypted**: data is encrypted in the browser before upload,
and the server only ever stores opaque ciphertext plus the user's email.

## What protects user data

- **End-to-end encryption.** PBKDF2-SHA256 (600,000 iterations) derives keys in
  the browser; data is sealed with AES-GCM. The encryption key never leaves the
  device. A full backend breach yields only unreadable ciphertext.
- **Row-Level Security.** Supabase RLS restricts every row to its owner
  (`auth.uid() = user_id`); the `anon` role is revoked. See `supabase/schema.sql`.
- **Public-by-design keys.** The Supabase URL and anon key in `helm-config.js`
  are publishable, RLS-gated values. They grant nothing without a valid session.
- **No third parties.** No analytics, trackers, ads, CDNs, or external fonts —
  everything is self-hosted, which keeps the attack surface small.

## Hardening enforced in this repo

- **Content-Security-Policy** (meta tag on every page): `default-src 'self'`,
  `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`, and a
  `connect-src` locked to `'self'` plus the Supabase origin — so even in the
  event of script injection, data cannot be exfiltrated to an arbitrary host.
  `script-src`/`style-src` allow `'unsafe-inline'` because the static host
  (GitHub Pages) cannot serve per-request nonces and the pages use inline
  scripts/styles; the connect/object/base/form locks remain effective.
- **Referrer-Policy** `strict-origin-when-cross-origin` (meta tag).
- **Dependency scanning.** Dependabot (`.github/dependabot.yml`) and a weekly
  `npm audit` workflow (`.github/workflows/security-audit.yml`) cover the iOS
  wrapper's npm, GitHub Actions, and Bundler dependencies. The web tools have
  zero runtime dependencies.

## Pre-launch checklist (dashboard config — cannot live in this repo)

GitHub Pages and Supabase settings live outside the codebase. Confirm these
before public launch:

- [ ] **Supabase CORS** restricted to the production origin
      (`https://helm.treetop.capital`).
- [ ] **Email confirmation** enabled for sign-ups (Supabase Auth settings).
- [ ] **SMTP provider** configured so password-reset / confirmation emails send
      reliably (the default Supabase mailer is rate-limited and not for prod).
- [ ] **Enforce HTTPS** enabled for the GitHub Pages custom domain (adds HSTS).
- [ ] **Response headers** — GitHub Pages cannot send custom headers, so
      `X-Frame-Options`, `X-Content-Type-Options: nosniff`, and CSP
      `frame-ancestors` are not enforceable there. If clickjacking protection
      becomes a requirement, front the site with a CDN/host that supports
      response headers (e.g. Cloudflare) and add them there.
- [ ] **Service worker cache** version (`sw.js`, `const CACHE`) bumped whenever
      `helm-config.js`, `helm-sync.js`, or cached pages change, so clients pick
      up the new files. (Bumped to `helm-v15` for this change.)

## Reporting a vulnerability

Please report suspected vulnerabilities privately to **guy@treetop.capital**
rather than opening a public issue. We aim to acknowledge within 3 business days.
