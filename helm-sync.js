/* =============================================================================
   HelpBnk — accounts + end-to-end encrypted cross-device sync
   -----------------------------------------------------------------------------
   Drop-in, dependency-free. Include AFTER helm-config.js on every page:

       <script src="helm-config.js"></script>     (adjust relative path)
       <script src="helm-sync.js"></script>

   How it stays private (end-to-end, envelope encryption):
     • From your password we derive 64 bytes with PBKDF2-SHA256 (600k iters):
         - bytes 0..31  -> "auth secret": the only thing the server ever sees as
            your password (it bcrypts it). It reveals nothing about the keys.
         - bytes 32..63 -> "password KEK": NEVER sent; it WRAPS the data key.
     • The vault is encrypted with a random Data Encryption Key (DEK). The DEK is
       wrapped (encrypted) twice and stored server-side: once by the password KEK,
       once by a recovery-key KEK. EITHER unlocks the data, so:
         - changing your password just re-wraps the DEK (data untouched);
         - forgetting your password -> reset via email + recovery key restores it.
     • The server only ever holds ciphertext + the wrapped keys; it cannot derive
       the DEK from either wrap without your password or recovery key.

   What syncs: every localStorage key beginning "founders-toolkit:" — the data
   the tools already save on-device — snapshotted, encrypted with the DEK, and
   stored as one opaque blob per user. Tool-agnostic; new tools covered for free.

   Recovery: a one-time recovery key (shown at sign-up) independently unwraps the
   DEK. Lose BOTH the password and the recovery key = data is unrecoverable.
   ============================================================================= */
(function () {
  "use strict";

  var CFG = window.HELM_CONFIG || {};
  var URL_BASE = (CFG.SUPABASE_URL || "").replace(/\/+$/, "");
  var ANON = CFG.SUPABASE_ANON_KEY || "";
  var CONFIGURED = !!(URL_BASE && ANON);

  // Web Crypto needs a secure context (https or localhost).
  var CRYPTO_OK = !!(window.crypto && window.crypto.subtle && window.isSecureContext);

  var PEPPER = "helm.treetop.capital/v1";     // fixed app-wide salt component
  var PBKDF2_ITER = 600000;                   // OWASP 2023 floor for PBKDF2-SHA256
  var REC_ITER = 200000;                      // recovery key is already high-entropy
  var KEY_PREFIX = "founders-toolkit:";       // localStorage keys we mirror
  var PUSH_DEBOUNCE_MS = 1500;

  // Persisted across page loads (same origin) — never holds secrets:
  var LS_SESSION = "helm:auth:session";       // Supabase tokens + user (JWT)
  var LS_META = "helm:sync:meta";             // { updated_at, hash } of last sync
  var LS_OWNER = "helm:owner";                // account id that owns the local data
  var LS_CONFLICT = "helm:sync:conflict-backup"; // same-user backup when both sides moved
  // Per-tab only, cleared when the tab closes — holds the raw AES key so you can
  // navigate between tool pages without re-entering your password each time:
  var SS_KEY = "helm:enc:key";

  // ---- tiny utils -----------------------------------------------------------
  function $(sel, root) { return (root || document).querySelector(sel); }
  function b64(buf) { var b = new Uint8Array(buf), s = "", i; for (i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s); }
  function unb64(str) { var bin = atob(str), a = new Uint8Array(bin.length), i; for (i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return a; }
  function enc(s) { return new TextEncoder().encode(s); }
  function nowISO() { return new Date().toISOString(); }
  // Parse a timestamp (JS or Postgres format) to millis for robust comparison —
  // never string-compare a server timestamptz against a client ISO string.
  function tms(s) { var t = Date.parse(s); return isNaN(t) ? 0 : t; }
  function readJSON(store, k) { try { return JSON.parse(store.getItem(k) || "null"); } catch (e) { return null; } }
  function writeJSON(store, k, v) { try { store.setItem(k, JSON.stringify(v)); } catch (e) {} }
  // Canonical (sorted-key) JSON so local vs remote comparisons are order-stable —
  // otherwise localStorage iteration order vs a decrypted object could differ and
  // make the snapshots look "changed" forever (reload loop / endless pushes).
  function canon(obj) { var keys = Object.keys(obj).sort(), o = {}, i; for (i = 0; i < keys.length; i++) o[keys[i]] = obj[keys[i]]; return JSON.stringify(o); }

  // FNV-1a — cheap change-detection hash over the snapshot (not security).
  function hashStr(s) { var h = 0x811c9dc5, i; for (i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0; } return ("0000000" + h.toString(16)).slice(-8); }

  // ---- key derivation -------------------------------------------------------
  // One PBKDF2 pass -> 64 bytes -> [authSecret(32) | aesKey(32)].
  async function deriveSecrets(email, password) {
    var salt = enc("helm:" + String(email).trim().toLowerCase() + ":" + PEPPER);
    var base = await crypto.subtle.importKey("raw", enc(password), "PBKDF2", false, ["deriveBits"]);
    var bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: salt, iterations: PBKDF2_ITER, hash: "SHA-256" }, base, 512);
    var bytes = new Uint8Array(bits);
    var authBytes = bytes.slice(0, 32);
    var keyBytes = bytes.slice(32, 64);
    var authSecret = b64(authBytes);          // used as the Supabase "password"
    return { authSecret: authSecret, keyBytes: keyBytes };
  }
  async function importAesKey(rawBytes) {
    return crypto.subtle.importKey("raw", rawBytes, { name: "AES-GCM" }, true, ["encrypt", "decrypt"]);
  }
  async function encryptSnapshot(key, obj) {
    var iv = crypto.getRandomValues(new Uint8Array(12));
    var ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv }, key, enc(JSON.stringify(obj)));
    return { iv: b64(iv), ciphertext: b64(ct) };
  }
  async function decryptBlob(key, ivB64, ctB64) {
    var pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(ivB64) }, key, unb64(ctB64));
    return JSON.parse(new TextDecoder().decode(pt));
  }

  // ---- envelope encryption --------------------------------------------------
  // The vault is encrypted with a random Data Encryption Key (DEK). The DEK is
  // wrapped (encrypted) separately by the password-derived key AND a recovery-key
  // -derived key, so EITHER can unlock the data. Changing the password just
  // re-wraps the DEK — the data and recovery key are untouched.
  async function genDEK() { var raw = crypto.getRandomValues(new Uint8Array(32)); return { raw: raw, key: await importAesKey(raw) }; }
  async function wrapKey(kekBytes, dekRaw) {
    var kek = await importAesKey(kekBytes);
    var iv = crypto.getRandomValues(new Uint8Array(12));
    var ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv }, kek, dekRaw);
    return { iv: b64(iv), ct: b64(ct) };
  }
  async function unwrapKey(kekBytes, wrap) {
    var kek = await importAesKey(kekBytes);
    var raw = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(wrap.iv) }, kek, unb64(wrap.ct));
    return new Uint8Array(raw);
  }
  // Recovery key: 160 bits of entropy, Crockford base32, dashed in groups of 4.
  function genRecoveryKey() {
    var A = "0123456789ABCDEFGHJKMNPQRSTVWXYZ", bytes = crypto.getRandomValues(new Uint8Array(20));
    var bits = 0, value = 0, out = "", i;
    for (i = 0; i < bytes.length; i++) { value = (value << 8) | bytes[i]; bits += 8; while (bits >= 5) { out += A[(value >>> (bits - 5)) & 31]; bits -= 5; } }
    if (bits > 0) out += A[(value << (5 - bits)) & 31];
    return out.replace(/(.{4})(?=.)/g, "$1-");
  }
  async function deriveRecKEK(recoveryKey) {
    var norm = String(recoveryKey).toUpperCase().replace(/[^A-Z0-9]/g, "");
    var base = await crypto.subtle.importKey("raw", enc(norm), "PBKDF2", false, ["deriveBits"]);
    var bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: enc("helm-recovery:" + PEPPER), iterations: REC_ITER, hash: "SHA-256" }, base, 256);
    return new Uint8Array(bits);
  }
  // Build a fresh key envelope (new DEK + new recovery key) wrapped by the given
  // password KEK; sets it as the active key and returns the recovery key to show.
  async function establishEnvelope(pwKekBytes) {
    var dek = await genDEK();
    var recoveryKey = genRecoveryKey();
    var keys = { v: 1, pw: await wrapKey(pwKekBytes, dek.raw), rec: await wrapKey(await deriveRecKEK(recoveryKey), dek.raw) };
    state.aesKey = dek.key;
    cacheKeyBytes(dek.raw);
    await push(true, keys);   // seed the vault (current local data) + store the wrapped keys
    return recoveryKey;
  }

  // ---- Supabase HTTP (no SDK) ----------------------------------------------
  function authHeaders(extra) {
    var h = { "apikey": ANON, "Content-Type": "application/json" };
    if (state.session && state.session.access_token) h["Authorization"] = "Bearer " + state.session.access_token;
    if (extra) for (var k in extra) h[k] = extra[k];
    return h;
  }
  async function api(path, opts) {
    opts = opts || {};
    var res = await fetch(URL_BASE + path, {
      method: opts.method || "GET",
      headers: authHeaders(opts.headers),
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    var text = await res.text();
    var data = text ? (function () { try { return JSON.parse(text); } catch (e) { return text; } })() : null;
    if (!res.ok) {
      var msg = (data && (data.msg || data.error_description || data.message || data.error)) || ("Request failed (" + res.status + ")");
      var err = new Error(msg); err.status = res.status; err.data = data; throw err;
    }
    return data;
  }

  async function gotrueSignup(email, authSecret) {
    return api("/auth/v1/signup", { method: "POST", body: { email: email, password: authSecret } });
  }
  async function gotruePassword(email, authSecret) {
    return api("/auth/v1/token?grant_type=password", { method: "POST", body: { email: email, password: authSecret } });
  }
  async function gotrueRefresh(refresh_token) {
    return api("/auth/v1/token?grant_type=refresh_token", { method: "POST", body: { refresh_token: refresh_token } });
  }
  async function gotrueUpdatePassword(authSecret) {
    return api("/auth/v1/user", { method: "PUT", body: { password: authSecret } });
  }
  async function gotrueRecover(email) {
    return api("/auth/v1/recover", { method: "POST", body: { email: email } });
  }
  async function gotrueGetUser() { return api("/auth/v1/user"); }
  async function vaultGet() {
    var uid = state.session && state.session.user && state.session.user.id;
    if (!uid) return null;
    var rows = await api("/rest/v1/vaults?select=ciphertext,iv,keys,updated_at&user_id=eq." + encodeURIComponent(uid));
    return (rows && rows[0]) || null;
  }
  // keys (the wrapped DEK envelope) is only sent when it changes (signup, password
  // change, recovery); a plain data push omits it so the column is preserved.
  async function vaultUpsert(ivB64, ctB64, keys) {
    var uid = state.session.user.id;
    var body = { user_id: uid, iv: ivB64, ciphertext: ctB64 };
    if (keys) body.keys = keys;
    // updated_at is set server-side (default now() on insert, trigger on update)
    // and returned to us, so timestamps are always server-authoritative.
    var rows = await api("/rest/v1/vaults?on_conflict=user_id", {
      method: "POST",
      headers: { "Prefer": "resolution=merge-duplicates,return=representation" },
      body: body,
    });
    return (rows && rows[0]) || null;
  }
  async function deleteAccount() {
    // Calls a security-definer function that deletes only the caller's own row
    // in auth.users; the vault row is removed via on-delete cascade.
    return api("/rest/v1/rpc/delete_my_account", { method: "POST", body: {} });
  }
  function clearLocalSynced() {
    var keys = [], i, k;
    for (i = 0; i < localStorage.length; i++) { k = localStorage.key(i); if (k && k.indexOf(KEY_PREFIX) === 0) keys.push(k); }
    keys.forEach(function (x) { try { localStorage.removeItem(x); } catch (e) {} });
  }
  // Full local wipe used on sign-out / delete / foreign eviction: the synced data
  // PLUS the owner stamp, conflict backup and meta. Crucially we leave NO plaintext
  // copy behind, so on a shared browser profile the next user can't read it.
  function wipeLocalAll() {
    clearLocalSynced();
    [LS_OWNER, LS_CONFLICT, LS_META].forEach(function (k) { try { localStorage.removeItem(k); } catch (e) {} });
  }
  function localOwner() { try { return localStorage.getItem(LS_OWNER); } catch (e) { return null; } }
  function stampOwner(uid) { try { if (uid) localStorage.setItem(LS_OWNER, uid); } catch (e) {} }
  // If the data on this device belongs to a DIFFERENT account, evict it entirely
  // (it's safe in that account's cloud vault) before we touch the current account.
  // Unowned/anonymous data (no stamp) is left alone — it's claimable by this user.
  function evictForeign(uid) {
    var o = localOwner();
    if (o && o !== uid) wipeLocalAll();
  }

  // ---- local snapshot of all founders-toolkit:* keys ------------------------
  function snapshot() {
    var out = {}, i, k;
    for (i = 0; i < localStorage.length; i++) {
      k = localStorage.key(i);
      if (k && k.indexOf(KEY_PREFIX) === 0) out[k] = localStorage.getItem(k);
    }
    return out;
  }
  function applySnapshot(obj) {
    // Replace the founders-toolkit:* namespace wholesale with the remote one.
    var i, k, existing = [];
    for (i = 0; i < localStorage.length; i++) { k = localStorage.key(i); if (k && k.indexOf(KEY_PREFIX) === 0) existing.push(k); }
    existing.forEach(function (key) { if (!Object.prototype.hasOwnProperty.call(obj, key)) localStorage.removeItem(key); });
    Object.keys(obj).forEach(function (key) { localStorage.setItem(key, obj[key]); });
  }

  // ---- in-memory state ------------------------------------------------------
  var state = {
    session: null,     // { access_token, refresh_token, expires_at, user }
    aesKey: null,      // CryptoKey (in memory; raw bytes cached per-tab)
    status: "idle",    // idle | syncing | synced | error | offline
    lastError: "",
    pushTimer: null,
  };

  function loadPersisted() {
    state.session = readJSON(localStorage, LS_SESSION);
    if (state.session && state.session.expires_in && !state.session.expires_at) {
      state.session.expires_at = 0; // force refresh path for older shape
    }
  }
  function persistSession(sess) {
    // Normalise GoTrue token response into our stored shape.
    if (!sess) { state.session = null; localStorage.removeItem(LS_SESSION); return; }
    var expires_at = sess.expires_at || (sess.expires_in ? Math.floor(Date.now() / 1000) + sess.expires_in : 0);
    state.session = {
      access_token: sess.access_token,
      refresh_token: sess.refresh_token,
      expires_at: expires_at,
      user: sess.user || (state.session && state.session.user) || null,
    };
    writeJSON(localStorage, LS_SESSION, state.session);
  }
  function cacheKeyBytes(keyBytes) {
    try { sessionStorage.setItem(SS_KEY, b64(keyBytes)); } catch (e) {}
  }
  function clearKeyCache() { try { sessionStorage.removeItem(SS_KEY); } catch (e) {} }

  async function ensureFreshSession() {
    if (!state.session) return false;
    var skewed = Math.floor(Date.now() / 1000) + 60;
    if (state.session.expires_at && state.session.expires_at > skewed) return true;
    if (!state.session.refresh_token) return false;
    try {
      var refreshed = await gotrueRefresh(state.session.refresh_token);
      persistSession(refreshed);
      return true;
    } catch (e) {
      if (e.status === 400 || e.status === 401) { signOutLocal(); }
      return false;
    }
  }

  // ---- core sync ------------------------------------------------------------
  function setStatus(s, err) { state.status = s; state.lastError = err || ""; renderWidget(); }

  async function pull(opts) {
    opts = opts || {};
    if (!state.session || !state.aesKey) return;
    var row = await vaultGet();
    var meta = readJSON(localStorage, LS_META) || {};
    if (!row) {
      // Account has no cloud copy yet. Foreign data was already evicted before we
      // got here (see evictForeign in signIn/signUp), so whatever remains belongs
      // to this user — seed the vault with it.
      await push(true);
      return;
    }
    var remoteObj;
    try { remoteObj = await decryptBlob(state.aesKey, row.iv, row.ciphertext); }
    catch (e) { throw new Error("Could not decrypt your data — wrong password?"); }

    var localSnap = snapshot();
    var localStr = canon(localSnap);
    var localHash = hashStr(localStr);
    var localChangedSinceSync = meta.hash && meta.hash !== localHash;
    var remoteNewer = !meta.updated_at || tms(row.updated_at) > tms(meta.updated_at);

    if (localChangedSinceSync && remoteNewer && !opts.force) {
      // Genuine conflict: both sides moved. Prefer remote but keep a same-user
      // backup (cleared on sign-out, so it never lingers for another user).
      try { localStorage.setItem(LS_CONFLICT, localStr); } catch (e) {}
    }
    var remoteStr = canon(remoteObj);
    if (remoteStr !== localStr) {
      applySnapshot(remoteObj);
      writeJSON(localStorage, LS_META, { updated_at: row.updated_at, hash: hashStr(remoteStr) });
      if (opts.reloadOnChange) { location.reload(); return; }
    } else {
      writeJSON(localStorage, LS_META, { updated_at: row.updated_at, hash: localHash });
    }
  }

  async function push(force, keys) {
    if (!state.session || !state.aesKey) return;
    var snap = snapshot();
    var snapStr = canon(snap);
    var meta = readJSON(localStorage, LS_META) || {};
    var h = hashStr(snapStr);
    if (!force && !keys && meta.hash === h) return;   // nothing changed
    setStatus("syncing");
    var blob = await encryptSnapshot(state.aesKey, snap);
    var row = await vaultUpsert(blob.iv, blob.ciphertext, keys);
    writeJSON(localStorage, LS_META, { updated_at: (row && row.updated_at) || nowISO(), hash: h });
    setStatus("synced");
  }

  function schedulePush() {
    if (!state.session || !state.aesKey) return;
    if (state.pushTimer) clearTimeout(state.pushTimer);
    state.pushTimer = setTimeout(function () {
      push(false).catch(function (e) { setStatus("error", e.message); });
    }, PUSH_DEBOUNCE_MS);
  }

  // ---- auth flows -----------------------------------------------------------
  async function signIn(email, password) {
    email = email.trim().toLowerCase();
    var sec = await deriveSecrets(email, password);
    var tok = await gotruePassword(email, sec.authSecret);   // throws on bad creds / unconfirmed
    persistSession(tok);
    var uid = state.session.user.id;
    evictForeign(uid);                 // remove any other account's data on this browser
    stampOwner(uid);                   // claim local data for this account (survives reload)
    var row = await vaultGet();
    if (row && row.keys && row.keys.pw) {
      // Normal: unwrap the data key with the password-derived key.
      var dekRaw;
      try { dekRaw = await unwrapKey(sec.keyBytes, row.keys.pw); }
      catch (e) { signOutLocal(); throw new Error("Wrong email or password."); }
      state.aesKey = await importAesKey(dekRaw);
      cacheKeyBytes(dekRaw);
      setStatus("syncing");
      await pull({ reloadOnChange: true });
      setStatus("synced");
      return {};
    }
    // No envelope yet — a legacy direct-encryption vault to migrate, or a brand
    // new account (e.g. first sign-in after email confirmation).
    if (row && row.ciphertext) {
      var legacyKey = await importAesKey(sec.keyBytes);
      var data;
      try { data = await decryptBlob(legacyKey, row.iv, row.ciphertext); }
      catch (e) { signOutLocal(); throw new Error("Wrong email or password."); }
      applySnapshot(data);
      writeJSON(localStorage, LS_META, { updated_at: row.updated_at, hash: hashStr(canon(data)) });
    }
    var recoveryKey = await establishEnvelope(sec.keyBytes);   // generates a recovery key to show
    setStatus("synced");
    return { recoveryKey: recoveryKey, reloadAfter: true };
  }

  async function signUp(email, password) {
    email = email.trim().toLowerCase();
    var sec = await deriveSecrets(email, password);
    var res = await gotrueSignup(email, sec.authSecret);
    // If email confirmation is OFF, signup returns a session -> set up the vault.
    if (res && res.access_token) {
      persistSession(res);
      var uid = state.session.user.id;
      evictForeign(uid);         // never seed a previous account's leftover data
      stampOwner(uid);
      setStatus("syncing");
      var recoveryKey = await establishEnvelope(sec.keyBytes);
      setStatus("synced");
      return { needsConfirmation: false, recoveryKey: recoveryKey };
    }
    // Email confirmation ON: no session until they confirm. Stash nothing secret.
    return { needsConfirmation: true };
  }

  async function changePassword(currentPw, newPw) {
    if (!state.session) throw new Error("Sign in first.");
    var email = state.session.user.email;
    var curSec = await deriveSecrets(email, currentPw);
    await gotruePassword(email, curSec.authSecret);   // verify current password
    var row = await vaultGet();
    var dekRaw;
    if (row && row.keys && row.keys.pw) { dekRaw = await unwrapKey(curSec.keyBytes, row.keys.pw); }
    else { dekRaw = new Uint8Array(await crypto.subtle.exportKey("raw", state.aesKey)); }
    var newSec = await deriveSecrets(email, newPw);
    await ensureFreshSession();
    await gotrueUpdatePassword(newSec.authSecret);
    // Re-wrap the SAME data key with the new password; recovery key is unchanged.
    var keys = { v: 1, pw: await wrapKey(newSec.keyBytes, dekRaw), rec: (row && row.keys && row.keys.rec) || (await wrapKey(await deriveRecKEK(genRecoveryKey()), dekRaw)) };
    state.aesKey = await importAesKey(dekRaw);
    cacheKeyBytes(dekRaw);
    await push(true, keys);    // re-encrypt (same data) + store the re-wrapped keys
    setStatus("synced");
  }

  // Forgot-password recovery. Runs inside a recovery session captured from the
  // email link (handleAuthRedirect). With the recovery key, the data is restored
  // intact; without it, a fresh vault + new recovery key are created.
  async function resetWithRecovery(newPassword, recoveryKeyInput) {
    if (!state.session) throw new Error("Your reset link expired — request a new one.");
    var email = state.session.user && state.session.user.email;
    if (!email) { var u = await gotrueGetUser(); email = u.email; state.session.user = { id: u.id, email: u.email }; }
    var uid = state.session.user.id;
    evictForeign(uid); stampOwner(uid);
    var row = await vaultGet();
    var dekRaw = null, keepRec = null;
    if (recoveryKeyInput && row && row.keys && row.keys.rec) {
      try { dekRaw = await unwrapKey(await deriveRecKEK(recoveryKeyInput), row.keys.rec); keepRec = row.keys.rec; }
      catch (e) { throw new Error("That recovery key didn't match. Check it and try again."); }
    }
    var newSec = await deriveSecrets(email, newPassword);
    await gotrueUpdatePassword(newSec.authSecret);
    var newRecoveryKey = null;
    if (!dekRaw) {                          // couldn't recover the data key -> fresh start
      dekRaw = (await genDEK()).raw;
      newRecoveryKey = genRecoveryKey();
      keepRec = await wrapKey(await deriveRecKEK(newRecoveryKey), dekRaw);
    }
    var keys = { v: 1, pw: await wrapKey(newSec.keyBytes, dekRaw), rec: keepRec };
    state.aesKey = await importAesKey(dekRaw);
    cacheKeyBytes(dekRaw);
    if (!newRecoveryKey) {                  // data recovered — pull it down, then re-store keys
      setStatus("syncing");
      await pull({ reloadOnChange: false });
    }
    await push(true, keys);
    state.recovering = false;
    persistSession(state.session);          // now persist — the reset succeeded, keep them signed in
    setStatus("synced");
    return { recoveryKey: newRecoveryKey, recovered: !newRecoveryKey };
  }

  function signOutLocal() {
    state.session = null; state.aesKey = null;
    localStorage.removeItem(LS_SESSION);
    localStorage.removeItem(LS_META);
    clearKeyCache();
    setStatus("idle");
  }
  async function signOut() {
    // Flush any pending changes to the cloud first (best effort) — the data is
    // safely E2E-encrypted there and returns on next sign-in.
    try { if (state.aesKey) await push(true); } catch (e) {}
    try { if (state.session) await api("/auth/v1/logout", { method: "POST" }); } catch (e) {}
    signOutLocal();
    wipeLocalAll();   // leave nothing behind for the next person on this browser
    try { location.reload(); } catch (e) {}
  }
  async function deleteMyAccount() {
    if (!state.session) throw new Error("Sign in first.");
    await ensureFreshSession();
    await deleteAccount();                 // removes auth user + vault (cascade)
    try { if (state.session) await api("/auth/v1/logout", { method: "POST" }); } catch (e) {}
    signOutLocal();
    wipeLocalAll();                        // wipe this device's copy too
    try { location.reload(); } catch (e) {}
  }

  // Restore an existing session + per-tab key on page load, then sync.
  async function resume() {
    loadPersisted();
    if (!state.session) { setStatus("idle"); return; }
    var ok = await ensureFreshSession();
    if (!ok) { setStatus("idle"); return; }
    var cached = sessionStorage.getItem(SS_KEY);
    if (cached) {
      try {
        state.aesKey = await importAesKey(unb64(cached));
        stampOwner(state.session.user.id);   // keep ownership current across reloads
        setStatus("syncing");
        await pull({ reloadOnChange: true });
        setStatus("synced");
        return;
      } catch (e) { clearKeyCache(); state.aesKey = null; }
    }
    // Signed in but key not in this tab — needs password to unlock sync.
    setStatus("locked");
  }

  // =========================================================================
  //  UI — a fixed account pill (top-right) + a modal. All injected from here.
  // =========================================================================
  var els = {};
  function injectStyles() {
    var css = '' +
      '.helm-acct{position:fixed;top:max(12px,env(safe-area-inset-top));right:max(12px,env(safe-area-inset-right));z-index:9000;font-family:"Outfit",system-ui,sans-serif}' +
      // Reserve room on the right of each tool page's top bar so the fixed pill
      // doesn't overlap the "All tools" link.
      '.topbar{padding-right:140px}@media (max-width:480px){.topbar{padding-right:54px}}' +
      '.helm-pill{display:inline-flex;align-items:center;gap:8px;border:1px solid var(--border,#E5E5DF);background:var(--card,#fff);color:var(--text,#1C1C1A);font:600 13px/1 "Outfit",system-ui,sans-serif;padding:9px 13px;border-radius:999px;cursor:pointer;box-shadow:0 1px 2px rgba(28,28,26,.05),0 6px 18px rgba(28,28,26,.06)}' +
      '.helm-pill:hover{border-color:#cfcfc8}' +
      '.helm-dot{width:8px;height:8px;border-radius:50%;background:#8A8A85;flex:0 0 auto}' +
      '.helm-dot.ok{background:#3f9d57}.helm-dot.busy{background:#d9a23b}.helm-dot.err{background:#c0532e}.helm-dot.lock{background:#1597C4}' +
      '.helm-ava{width:22px;height:22px;border-radius:50%;background:var(--brand,#1597C4);color:#fff;display:inline-flex;align-items:center;justify-content:center;font:700 11px/1 "Outfit",system-ui,sans-serif}' +
      '.helm-modal{position:fixed;inset:0;z-index:9001;display:none;align-items:flex-start;justify-content:center;background:rgba(20,20,18,.42);backdrop-filter:blur(2px);padding:24px 16px;overflow:auto}' +
      '.helm-modal.show{display:flex}' +
      '.helm-sheet{background:var(--card,#fff);color:var(--text,#1C1C1A);border:1px solid var(--border,#E5E5DF);border-radius:18px;max-width:400px;width:100%;margin-top:6vh;padding:22px 22px 20px;box-shadow:0 24px 60px rgba(20,20,18,.28);font-family:"Manrope",system-ui,sans-serif}' +
      '.helm-sheet h2{font-family:"Outfit",sans-serif;font-size:1.25rem;margin:2px 0 4px;letter-spacing:-.01em}' +
      '.helm-sheet p.sub{color:var(--text-2,#5C5C58);font-size:.9rem;margin:0 0 16px;line-height:1.5}' +
      '.helm-field{margin:0 0 12px}' +
      '.helm-field label{display:block;font:600 12px/1 "Outfit",sans-serif;color:var(--text-2,#5C5C58);margin:0 0 5px}' +
      '.helm-field input{width:100%;box-sizing:border-box;border:1px solid var(--border,#E5E5DF);background:var(--input-bg,#F2F2F0);border-radius:10px;padding:11px 12px;font:500 15px/1.2 "Manrope",system-ui,sans-serif;color:var(--text,#1C1C1A)}' +
      '.helm-field input:focus{outline:2px solid var(--brand,#1597C4);outline-offset:1px;border-color:transparent}' +
      '.helm-btn{width:100%;border:0;background:var(--brand,#1597C4);color:#fff;font:600 15px/1 "Outfit",sans-serif;padding:13px;border-radius:11px;cursor:pointer;margin-top:4px}' +
      '.helm-btn:hover{background:var(--brand-dark,#117C9F)}.helm-btn[disabled]{opacity:.6;cursor:default}' +
      '.helm-btn.ghost{background:transparent;color:var(--text-2,#5C5C58);border:1px solid var(--border,#E5E5DF)}' +
      '.helm-btn.ghost:hover{background:#f4f4f1}' +
      '.helm-row{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-top:10px}' +
      '.helm-link{background:none;border:0;color:var(--brand,#1597C4);font:600 13px/1 "Outfit",sans-serif;cursor:pointer;padding:6px 2px}' +
      '.helm-err{color:#c0532e;font-size:.85rem;margin:2px 0 10px;min-height:1px}' +
      '.helm-ok{color:#2B5332;font-size:.85rem;margin:2px 0 10px}' +
      '.helm-note{font-size:.8rem;color:var(--muted,#8A8A85);line-height:1.5;margin:14px 0 0;border-top:1px solid var(--border,#E5E5DF);padding-top:12px}' +
      '.helm-x{position:absolute;top:14px;right:16px;background:none;border:0;font-size:22px;line-height:1;color:var(--muted,#8A8A85);cursor:pointer}' +
      '.helm-sheet{position:relative}' +
      '.helm-status-line{font-size:.82rem;color:var(--text-2,#5C5C58);margin:0 0 14px}' +
      '.helm-reckey{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:1.05rem;letter-spacing:.04em;word-break:break-all;background:var(--input-bg,#F2F2F0);border:1px dashed var(--brand,#1597C4);border-radius:10px;padding:14px 16px;color:var(--text,#1C1C1A);text-align:center}' +
      '@media (max-width:480px){.helm-pill span.lbl{display:none}}';
    var s = document.createElement("style"); s.textContent = css; document.head.appendChild(s);
  }

  function buildDOM() {
    var wrap = document.createElement("div");
    wrap.className = "helm-acct";
    wrap.innerHTML =
      '<button class="helm-pill" id="helm-pill" type="button" aria-haspopup="dialog">' +
        '<span class="helm-dot" id="helm-dot"></span>' +
        '<span class="lbl" id="helm-pill-lbl">Sign in</span>' +
      '</button>';
    document.body.appendChild(wrap);

    var modal = document.createElement("div");
    modal.className = "helm-modal";
    modal.id = "helm-modal";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.innerHTML = '<div class="helm-sheet" id="helm-sheet"></div>';
    document.body.appendChild(modal);

    els.pill = $("#helm-pill");
    els.dot = $("#helm-dot");
    els.lbl = $("#helm-pill-lbl");
    els.modal = $("#helm-modal");
    els.sheet = $("#helm-sheet");

    els.pill.addEventListener("click", openModal);
    els.modal.addEventListener("click", function (e) { if (e.target === els.modal) closeModal(); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeModal(); });
  }

  function openModal() {
    state.changeOpen = false; state.deleteOpen = false;   // always open to the default view
    if (!CONFIGURED) { renderSheet("unconfigured"); }
    else if (!CRYPTO_OK) { renderSheet("insecure"); }
    else if (state.status === "locked") { renderSheet("unlock"); }
    else if (state.session) { renderSheet("account"); }
    else { renderSheet("signin"); }
    els.modal.classList.add("show");
  }
  function closeModal() { els.modal.classList.remove("show"); }

  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]; }); }
  function downloadText(name, text) {
    try {
      var blob = new Blob([text], { type: "text/plain" }), url = URL.createObjectURL(blob), a = document.createElement("a");
      a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    } catch (e) {}
  }

  function renderSheet(view, ctx) {
    ctx = ctx || {};
    var h = '<button class="helm-x" id="helm-close" aria-label="Close">×</button>';
    if (view === "unconfigured") {
      h += '<h2>Accounts aren’t switched on yet</h2>' +
        '<p class="sub">Cross-device sync needs a one-time backend setup. Until then, HelpBnk works fully on this device — nothing is lost.</p>' +
        '<p class="helm-note">Developer: add your Supabase URL + anon key in <code>helm-config.js</code> (see SUPABASE_SETUP.md).</p>';
    } else if (view === "insecure") {
      h += '<h2>Secure connection needed</h2>' +
        '<p class="sub">Accounts and encryption need an <b>https</b> page. This works on the live site (helm.treetop.capital); it’s just disabled on insecure/local pages.</p>';
    } else if (view === "signin" || view === "signup") {
      var up = view === "signup";
      h += '<h2>' + (up ? 'Create your HelpBnk account' : 'Sign in to HelpBnk') + '</h2>' +
        '<p class="sub">' + (up
          ? 'Your details are encrypted with your password before they leave this device — we can’t read them, and we can’t reset your password.'
          : 'Sync your saved company details securely across your devices.') + '</p>' +
        (ctx.note ? '<div class="helm-ok">' + esc(ctx.note) + '</div>' : '') +
        '<div class="helm-err" id="helm-err">' + (ctx.error ? esc(ctx.error) : '') + '</div>' +
        '<form id="helm-form">' +
          '<div class="helm-field"><label>Email</label><input id="helm-email" type="email" autocomplete="username" required></div>' +
          '<div class="helm-field"><label>Password</label><input id="helm-pw" type="password" autocomplete="' + (up ? 'new-password' : 'current-password') + '" required minlength="8"></div>' +
          (up ? '<div class="helm-field"><label>Confirm password</label><input id="helm-pw2" type="password" autocomplete="new-password" required minlength="8"></div>' : '') +
          '<button class="helm-btn" id="helm-submit" type="submit">' + (up ? 'Create account' : 'Sign in') + '</button>' +
        '</form>' +
        '<div class="helm-row">' +
          (up ? '<span></span>' : '<button class="helm-link" id="helm-forgot" type="button">Forgot password?</button>') +
          '<button class="helm-link" id="helm-toggle" type="button">' + (up ? 'Have an account? Sign in' : 'New here? Create an account') + '</button>' +
        '</div>' +
        (up ? '<p class="helm-note">🔒 <b>End-to-end encrypted.</b> Your details are scrambled with your password on this device before they’re saved — even if our servers were breached, your data would be unreadable. After signing up you’ll get a <b>recovery key</b> to save, in case you ever forget your password.</p>' : '');
    } else if (view === "confirm") {
      h += '<h2>Check your email</h2>' +
        '<p class="sub">We’ve sent a confirmation link to <b>' + esc(ctx.email) + '</b>. Click it, then come back and sign in.</p>' +
        '<button class="helm-btn" id="helm-toconfirm-signin" type="button">Back to sign in</button>';
    } else if (view === "unlock") {
      h += '<h2>Unlock sync</h2>' +
        '<p class="sub">You’re signed in as <b>' + esc(state.session.user.email) + '</b>. Enter your password to decrypt your data on this tab.</p>' +
        '<div class="helm-err" id="helm-err"></div>' +
        '<form id="helm-form">' +
          '<div class="helm-field"><label>Password</label><input id="helm-pw" type="password" autocomplete="current-password" required></div>' +
          '<button class="helm-btn" id="helm-submit" type="submit">Unlock</button>' +
        '</form>' +
        '<div class="helm-row"><span></span><button class="helm-link" id="helm-signout" type="button">Sign out</button></div>';
    } else if (view === "account") {
      var email = state.session.user.email;
      var meta = readJSON(localStorage, LS_META) || {};
      var when = meta.updated_at ? new Date(meta.updated_at).toLocaleString() : "—";
      var statusTxt = ({ syncing: "Syncing…", synced: "All changes synced", error: "Sync error: " + state.lastError, locked: "Locked on this tab" })[state.status] || "Connected";
      h += '<h2>Your account</h2>' +
        '<p class="sub">' + esc(email) + '</p>' +
        '<p class="helm-status-line"><b>' + esc(statusTxt) + '</b><br>Last synced: ' + esc(when) + '</p>' +
        (state.changeOpen ? (
          '<div class="helm-err" id="helm-err"></div>' +
          '<form id="helm-cpw-form">' +
            '<div class="helm-field"><label>Current password</label><input id="helm-cur" type="password" autocomplete="current-password" required></div>' +
            '<div class="helm-field"><label>New password</label><input id="helm-new" type="password" autocomplete="new-password" required minlength="8"></div>' +
            '<button class="helm-btn" id="helm-cpw-submit" type="submit">Change password &amp; re-encrypt</button>' +
          '</form>' +
          '<div class="helm-row"><span></span><button class="helm-link" id="helm-change-cancel" type="button">Cancel</button></div>'
        ) : state.deleteOpen ? (
          '<div class="helm-err" id="helm-err"></div>' +
          '<p class="sub" style="color:#c0532e"><b>Delete your account permanently?</b> This removes your account and all data synced to it. It cannot be undone, and because your data is end-to-end encrypted we cannot recover it afterwards.</p>' +
          '<button class="helm-btn" id="helm-del-confirm" type="button" style="background:#c0532e">Permanently delete my account</button>' +
          '<div class="helm-row"><span></span><button class="helm-link" id="helm-del-cancel" type="button">Cancel</button></div>'
        ) : (
          '<button class="helm-btn ghost" id="helm-sync-now" type="button">Sync now</button>' +
          '<div class="helm-row"><button class="helm-link" id="helm-change" type="button">Change password</button>' +
          '<button class="helm-link" id="helm-signout" type="button">Sign out</button></div>' +
          '<div class="helm-row"><span></span><button class="helm-link" id="helm-delete" type="button" style="color:#c0532e">Delete account</button></div>'
        )) +
        '<p class="helm-note">🔒 End-to-end encrypted — your data is scrambled with your password before it leaves this device, so we can only ever store unreadable ciphertext. Forgot your password? You can recover with your <b>recovery key</b>.</p>';
    } else if (view === "forgot") {
      h += '<h2>Reset your password</h2>' +
        '<p class="sub">Enter your email and we’ll send a reset link. You’ll set a new password — and if you have your <b>recovery key</b>, your data comes back with it.</p>' +
        '<div class="helm-err" id="helm-err"></div>' +
        '<form id="helm-form">' +
          '<div class="helm-field"><label>Email</label><input id="helm-email" type="email" autocomplete="username" required></div>' +
          '<button class="helm-btn" id="helm-submit" type="submit">Send reset link</button>' +
        '</form>' +
        '<div class="helm-row"><span></span><button class="helm-link" id="helm-toggle" type="button">Back to sign in</button></div>';
    } else if (view === "forgot-sent") {
      h += '<h2>Check your email</h2>' +
        '<p class="sub">If <b>' + esc(ctx.email) + '</b> has an account, a reset link is on its way. Open it on this device, then set a new password.</p>' +
        '<button class="helm-btn" id="helm-toconfirm-signin" type="button">Back to sign in</button>';
    } else if (view === "reset-password") {
      h += '<h2>Set a new password</h2>' +
        '<p class="sub">Choose a new password for <b>' + esc((state.session && state.session.user && state.session.user.email) || "your account") + '</b>. If you have your recovery key, add it to bring your data back.</p>' +
        '<div class="helm-err" id="helm-err"></div>' +
        '<form id="helm-form">' +
          '<div class="helm-field"><label>New password</label><input id="helm-pw" type="password" autocomplete="new-password" required minlength="8"></div>' +
          '<div class="helm-field"><label>Recovery key <span style="font-weight:400;color:var(--muted,#8A8A85)">— optional, to restore your data</span></label><input id="helm-rec" type="text" autocomplete="off" placeholder="XXXX-XXXX-XXXX-…"></div>' +
          '<button class="helm-btn" id="helm-submit" type="submit">Set new password</button>' +
        '</form>' +
        '<p class="helm-note">No recovery key? You’ll still get back into your account, but data that lived only in the cloud was encrypted with your old password and can’t be restored.</p>';
    } else if (view === "recovery-key") {
      h += '<h2>Save your recovery key</h2>' +
        '<p class="sub">' + (ctx.recovered ? 'Your data is back. ' : '') + 'This is the <b>only</b> way back into your data if you forget your password — we can’t reset it for you. Store it somewhere safe (a password manager is ideal).</p>' +
        '<div class="helm-reckey" id="helm-reckey">' + esc(ctx.key) + '</div>' +
        '<div class="helm-row" style="margin:10px 0 4px"><button class="helm-link" id="helm-copy-rec" type="button">Copy</button><button class="helm-link" id="helm-dl-rec" type="button">Download</button></div>' +
        '<label style="display:flex;gap:8px;align-items:flex-start;font-size:.88rem;color:var(--text-2,#5C5C58);margin:12px 0 14px"><input type="checkbox" id="helm-rec-ack" style="margin-top:3px"> I’ve saved my recovery key somewhere safe.</label>' +
        '<button class="helm-btn" id="helm-rec-done" type="button" disabled>Continue</button>';
    }
    els.sheet.innerHTML = h;
    wireSheet(view, ctx);
  }

  function busy(btn, on, label) { if (!btn) return; btn.disabled = on; if (label != null) btn.textContent = label; }
  function showErr(msg) { var e = $("#helm-err"); if (e) e.textContent = msg || ""; }

  function wireSheet(view, ctx) {
    var close = $("#helm-close"); if (close) close.addEventListener("click", closeModal);

    if (view === "signin" || view === "signup") {
      var up = view === "signup";
      $("#helm-toggle").addEventListener("click", function () { renderSheet(up ? "signin" : "signup"); });
      var fg = $("#helm-forgot"); if (fg) fg.addEventListener("click", function () { renderSheet("forgot"); });
      $("#helm-form").addEventListener("submit", async function (e) {
        e.preventDefault();
        showErr("");
        var email = $("#helm-email").value, pw = $("#helm-pw").value;
        if (up && pw !== $("#helm-pw2").value) { showErr("Passwords don’t match."); return; }
        if (pw.length < 8) { showErr("Use at least 8 characters."); return; }
        var btn = $("#helm-submit"); busy(btn, true, up ? "Creating…" : "Signing in…");
        try {
          var r = up ? await signUp(email, pw) : await signIn(email, pw);
          if (up && r.needsConfirmation) { renderSheet("confirm", { email: email }); return; }
          if (r && r.recoveryKey) { renderSheet("recovery-key", { key: r.recoveryKey, reloadAfter: r.reloadAfter }); return; }
          closeModal();
        } catch (err) {
          showErr(friendly(err));
          busy(btn, false, up ? "Create account" : "Sign in");
        }
      });
    } else if (view === "forgot") {
      $("#helm-toggle").addEventListener("click", function () { renderSheet("signin"); });
      $("#helm-form").addEventListener("submit", async function (e) {
        e.preventDefault(); showErr("");
        var email = $("#helm-email").value.trim().toLowerCase(); var btn = $("#helm-submit"); busy(btn, true, "Sending…");
        try { await gotrueRecover(email); renderSheet("forgot-sent", { email: email }); }
        catch (err) { showErr(friendly(err)); busy(btn, false, "Send reset link"); }
      });
    } else if (view === "reset-password") {
      $("#helm-form").addEventListener("submit", async function (e) {
        e.preventDefault(); showErr("");
        var pw = $("#helm-pw").value, rec = $("#helm-rec").value.trim();
        if (pw.length < 8) { showErr("Use at least 8 characters."); return; }
        var btn = $("#helm-submit"); busy(btn, true, "Setting…");
        try {
          var r = await resetWithRecovery(pw, rec || null);
          if (r.recoveryKey) { renderSheet("recovery-key", { key: r.recoveryKey, reloadAfter: true }); }
          else { closeModal(); try { location.reload(); } catch (e) {} }   // data recovered, signed in
        } catch (err) { showErr(friendly(err)); busy(btn, false, "Set new password"); }
      });
    } else if (view === "recovery-key") {
      var keyText = ctx.key;
      $("#helm-copy-rec").addEventListener("click", function () { try { navigator.clipboard.writeText(keyText); } catch (e) {} });
      $("#helm-dl-rec").addEventListener("click", function () { downloadText("helm-recovery-key.txt", "HelpBnk recovery key\n\n" + keyText + "\n\nKeep this safe. It restores your data if you forget your password.\nhelm.treetop.capital"); });
      $("#helm-rec-ack").addEventListener("change", function (e) { $("#helm-rec-done").disabled = !e.target.checked; });
      $("#helm-rec-done").addEventListener("click", function () { closeModal(); if (ctx.reloadAfter) { try { location.reload(); } catch (e) {} } });
    } else if (view === "confirm" || view === "forgot-sent") {
      $("#helm-toconfirm-signin").addEventListener("click", function () { renderSheet("signin"); });
    } else if (view === "unlock") {
      $("#helm-signout").addEventListener("click", async function () { await signOut(); closeModal(); });
      $("#helm-form").addEventListener("submit", async function (e) {
        e.preventDefault(); showErr("");
        var pw = $("#helm-pw").value, btn = $("#helm-submit"); busy(btn, true, "Unlocking…");
        try {
          var email = state.session.user.email;
          var sec = await deriveSecrets(email, pw);
          state.aesKey = await importAesKey(sec.keyBytes);
          await pull({});                 // verifies the key (throws if wrong); no reload yet
          cacheKeyBytes(sec.keyBytes);     // cache only AFTER the key is proven correct
          setStatus("synced"); closeModal();
          try { location.reload(); } catch (e) {}   // reflect any pulled data in the tool UI
        } catch (err) {
          state.aesKey = null;
          showErr("That password didn’t unlock your data. Try again.");
          busy(btn, false, "Unlock");
        }
      });
    } else if (view === "account") {
      var so = $("#helm-signout"); if (so) so.addEventListener("click", async function () { await signOut(); closeModal(); });
      var sn = $("#helm-sync-now"); if (sn) sn.addEventListener("click", async function () {
        busy(sn, true, "Syncing…");
        try { await pull({}); await push(true); renderSheet("account"); } catch (e) { showErr && showErr(e.message); busy(sn, false, "Sync now"); }
      });
      var ch = $("#helm-change"); if (ch) ch.addEventListener("click", function () { state.changeOpen = true; renderSheet("account"); });
      var chc = $("#helm-change-cancel"); if (chc) chc.addEventListener("click", function () { state.changeOpen = false; renderSheet("account"); });
      var cf = $("#helm-cpw-form"); if (cf) cf.addEventListener("submit", async function (e) {
        e.preventDefault(); showErr("");
        var btn = $("#helm-cpw-submit"); busy(btn, true, "Re-encrypting…");
        try {
          await changePassword($("#helm-cur").value, $("#helm-new").value);
          state.changeOpen = false; renderSheet("account");
        } catch (err) { showErr(friendly(err)); busy(btn, false, "Change password & re-encrypt"); }
      });
      var dl = $("#helm-delete"); if (dl) dl.addEventListener("click", function () { state.deleteOpen = true; renderSheet("account"); });
      var dlc = $("#helm-del-cancel"); if (dlc) dlc.addEventListener("click", function () { state.deleteOpen = false; renderSheet("account"); });
      var dlcf = $("#helm-del-confirm"); if (dlcf) dlcf.addEventListener("click", async function () {
        busy(dlcf, true, "Deleting…");
        try { await deleteMyAccount(); } catch (err) { showErr(friendly(err)); busy(dlcf, false, "Permanently delete my account"); }
      });
    }
  }

  function friendly(err) {
    var m = (err && err.message) || "Something went wrong.";
    if (/invalid login credentials/i.test(m)) return "Wrong email or password.";
    if (/email not confirmed/i.test(m)) return "Please confirm your email first (check your inbox), then sign in.";
    if (/already registered|already been registered|user already/i.test(m)) return "That email already has an account — sign in instead.";
    if (/decrypt/i.test(m)) return "Wrong password — couldn’t decrypt your data.";
    if (/failed to fetch|networkerror/i.test(m)) return "Couldn’t reach the server. Check your connection.";
    return m;
  }

  // ---- widget (pill) rendering ---------------------------------------------
  function renderWidget() {
    if (!els.pill) return;
    var dotCls = "helm-dot", lbl = "Sign in", title = "Sign in to sync";
    if (!CONFIGURED || !CRYPTO_OK) { dotCls += ""; lbl = "Sign in"; }
    else if (state.status === "locked") { dotCls += " lock"; lbl = "Unlock"; title = "Signed in — unlock sync"; }
    else if (state.session) {
      var initial = (state.session.user.email || "?").charAt(0).toUpperCase();
      els.pill.innerHTML = '<span class="helm-dot ' + (state.status === "syncing" ? "busy" : state.status === "error" ? "err" : "ok") + '"></span>' +
        '<span class="helm-ava">' + esc(initial) + '</span><span class="lbl">' +
        (state.status === "syncing" ? "Syncing…" : state.status === "error" ? "Sync error" : "Synced") + '</span>';
      els.pill.title = state.session.user.email;
      return;
    }
    els.pill.innerHTML = '<span class="' + dotCls + '"></span><span class="lbl">' + lbl + '</span>';
    els.pill.title = title;
  }

  // ---- wire localStorage changes -> debounced push --------------------------
  function hookStorage() {
    // Same-tab writes: patch Storage.PROTOTYPE (not the instance — assigning
    // localStorage.setItem on the real Storage object can create a "setItem"
    // storage entry instead of overriding the method). Guard against double-patch.
    try {
      var proto = window.Storage && window.Storage.prototype;
      if (proto && !proto.__helmPatched) {
        var oSet = proto.setItem, oRem = proto.removeItem;
        proto.setItem = function (k, v) { oSet.call(this, k, v); if (this === window.localStorage && k && k.indexOf(KEY_PREFIX) === 0) schedulePush(); };
        proto.removeItem = function (k) { oRem.call(this, k); if (this === window.localStorage && k && k.indexOf(KEY_PREFIX) === 0) schedulePush(); };
        proto.__helmPatched = true;
      }
    } catch (e) { /* fall back to the poll below */ }
    // Other tabs writing the same origin:
    window.addEventListener("storage", function (e) {
      if (e.storageArea && e.storageArea !== localStorage) return;
      if (e.key && e.key.indexOf(KEY_PREFIX) === 0) schedulePush();
    });
    // Backstop: catch anything the patch/event missed (and changes made before
    // sync was unlocked). Cheap hash check; only schedules a push if it differs.
    setInterval(function () {
      if (!state.session || !state.aesKey) return;
      var meta = readJSON(localStorage, LS_META) || {};
      if (hashStr(canon(snapshot())) !== meta.hash) schedulePush();
    }, 5000);
    // Flush before the tab is hidden/closed:
    window.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "hidden" && state.session && state.aesKey) {
        if (state.pushTimer) clearTimeout(state.pushTimer);
        push(false).catch(function () {});
      }
    });
  }

  // When the user returns from an email-confirmation link, Supabase appends auth
  // params (success tokens or an error) to the URL. Acknowledge it and open the
  // sign-in panel — they still need their password to derive the encryption key,
  // so we can't silently auto-sign-in, but we shouldn't dump them on a blank page.
  function handleAuthRedirect() {
    var raw = (location.hash ? location.hash.substring(1) : "") || (location.search ? location.search.substring(1) : "");
    if (!raw) return false;
    var p;
    try { p = new URLSearchParams(raw); } catch (e) { return false; }
    var err = p.get("error_description") || p.get("error");
    var at = p.get("access_token");
    var recovery = p.get("type") === "recovery" && at;
    var confirmed = at || p.get("type") === "signup" || p.get("type") === "magiclink";
    if (!err && !confirmed && !recovery) return false;
    // Strip the auth params so a refresh doesn't re-trigger this.
    try { history.replaceState(null, "", location.pathname); } catch (e) {}
    if (recovery) {
      // Capture the recovery session IN MEMORY only (not persisted, so a stray
      // reload doesn't leave a half-recovered state); resetWithRecovery persists
      // it once the new password is set.
      state.session = { access_token: at, refresh_token: p.get("refresh_token"), expires_at: Math.floor(Date.now() / 1000) + (parseInt(p.get("expires_in"), 10) || 3600), user: null };
      state.recovering = true;
      renderSheet("reset-password", {});
      els.modal.classList.add("show");
      return true;
    }
    if (state.session) return true;   // already signed in elsewhere; nothing to prompt
    if (err) {
      var msg = /expired|invalid/i.test(err)
        ? "That confirmation link has expired or was already used. Sign in, or create your account again."
        : decodeURIComponent(String(err).replace(/\+/g, " "));
      renderSheet("signin", { error: msg });
    } else {
      renderSheet("signin", { note: "✓ Email confirmed — sign in to continue." });
    }
    els.modal.classList.add("show");
    return true;
  }

  // ---- boot -----------------------------------------------------------------
  function boot() {
    // Dormant until a backend is configured: no UI, no footprint, tools unchanged.
    if (!CONFIGURED) return;
    injectStyles();
    buildDOM();
    renderWidget();
    if (!CRYPTO_OK) return;   // configured but insecure context (e.g. http): show pill, explain
    hookStorage();
    resume().catch(function (e) { setStatus("error", e.message); });
    handleAuthRedirect();
  }

  // Expose a tiny hook so tools could trigger an immediate sync if they want.
  window.HelmSync = {
    syncNow: function () { return push(true); },
    isSignedIn: function () { return !!state.session; },
    status: function () { return state.status; },
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
