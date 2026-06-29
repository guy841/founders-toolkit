# HelpBnk — Ops Runbook

Practical operations for running HelpBnk in production. See
[`ARCHITECTURE.md`](ARCHITECTURE.md) for how it works.

## 0. What you own / access checklist
- [ ] **GitHub** repo + Pages settings (source = `main`, custom domain).
- [ ] **DNS** for `helm.treetop.capital` (CNAME → GitHub Pages).
- [ ] **Supabase** project (Database, Auth, Email/SMTP, Backups).
- [ ] **Apple Developer** account (only if shipping the iOS app).
- [ ] Password manager entries for the above (no shared creds in the repo).

## 1. Deploy the web app (routine)
The site is static; deploying = pushing to `main`, Pages rebuilds automatically.

1. Work on a branch; make changes.
2. **Bump the cache:** edit `sw.js` → `const CACHE = "helpbnk-vN+1";`
   *(Skipping this makes returning users see stale pages — the #1 gotcha.)*
3. Commit → merge to `main` → push.
4. Wait ~1–2 min for Pages to build.
5. Verify at <https://helm.treetop.capital> (hard-refresh: Cmd/Ctrl-Shift-R).
   Confirm the service worker updated (DevTools → Application → Service Workers).

## 2. Rollback
```
git revert <bad-commit>      # or: git revert <range>
# bump sw.js CACHE again
git push origin main
```
Pages redeploys the reverted state. Data is unaffected (it lives in Supabase / on
devices, not in the static build).

## 3. Supabase operations
**Schema changes** — edit `supabase/schema.sql` and run it in the SQL editor. It is
idempotent (`create ... if not exists`, `create or replace`, `drop policy if exists`).

**Viewing data** — `public.vaults` contains only ciphertext + IV + wrapped keys; it is
**not human-readable** and cannot be decrypted server-side. `auth.users` holds emails.

**Backups & restore** — Supabase Dashboard → Database → Backups (daily; enable PITR on
Pro for point-in-time). Restore via the dashboard. Restoring brings back ciphertext
intact; no decryption needed (clients still hold their keys).

**Email/SMTP** — Auth → Email Templates / SMTP settings. Test the sign-up
confirmation mail after any change (deliverability is the usual failure point).

**Posture to keep:** "Automatically expose new tables" = OFF; RLS enabled on every
table; `anon` granted nothing on `vaults`.

## 4. Key & secret rotation
| Secret | Where | Rotate when / how | Impact |
|--------|-------|-------------------|--------|
| anon/publishable key + URL | `helm-config.js` (public) | Low urgency (public by design). Replace in `helm-config.js`, bump cache, deploy. | None to users |
| `service_role` key | Supabase dashboard only | Immediately if ever leaked. | Server-side only |
| JWT secret | Supabase → Auth settings | If suspected compromise. | All sessions invalidated; users re-sign-in. Data safe. |

There are **no runtime npm dependencies** in the web app, so there is no dependency
patch treadmill for the site itself.

## 5. Domain / DNS
- `CNAME` file in the repo sets the Pages custom domain.
- DNS: CNAME `helm.treetop.capital` → `<github-username>.github.io`. Keep "Enforce
  HTTPS" enabled in Pages settings.
- Changing the brand domain later: update DNS, the `CNAME` file, and any absolute
  URLs (e.g. the email template image, recovery-key footer text).

## 6. iOS release (if applicable)
- `app/` is a Capacitor wrapper; release is via the `ios.yml` GitHub Action + fastlane.
- Export compliance: standard AES for local data = **exempt** (see `app/APP_STORE.md`).

## 7. Health checks
- **Site:** `curl -I https://helm.treetop.capital` → `200`.
- **Backend:** Supabase dashboard status; smoke-test sign-up + sign-in + a sync.
- After any deploy: confirm a tool loads, the account pill appears, and the cache
  version advanced.

## 8. Incident response
**Site down / broken deploy** → roll back (§2); check Pages build log and DNS/HTTPS.

**Supabase outage** → the app still works on-device; sync just pauses and resumes.
Communicate that no data is lost.

**Suspected breach** → because vault data is end-to-end encrypted, ciphertext exposure
is low-impact; **emails in `auth.users` are the exposed PII**. Steps: rotate
`service_role` + JWT secret, review RLS policies and dashboard access, then notify per
your data-protection policy. Confirm no plaintext user data exists server-side (by
design it does not).

## 9. Common support scenarios
| Scenario | Resolution |
|----------|------------|
| Forgot password, **has** recovery key | "Forgot password?" flow → recovery key unwraps the DEK → set new password (re-wraps DEK). Data preserved. |
| Lost password **and** recovery key | Synced data is **unrecoverable by design**. They can reset the password via email to regain the account, but the vault stays locked; option is to delete and start fresh. |
| Delete account | Account menu → delete → calls `delete_my_account()` RPC; cascades and removes the vault. |
| Data not syncing | Check: signed in? on HTTPS (Web Crypto needs a secure context)? Supabase up? browser not blocking localStorage / in private mode? |
| Lost data with **no account** | On-device-only data is gone if the browser was cleared. Encourage account creation (the in-app "save your work" prompt covers this). |

## 10. Data protection notes
- Data minimisation is strong: only email + an unreadable blob are held server-side.
- Users can self-delete (account + vault) from the client.
- Put a **DPA with Supabase** in place and confirm the project region for residency.
