/* Aarambh Pre School — biometric unlock (fingerprint / Face ID / device screen lock).
   Loaded after app-supabase.js. The password stays the real login; this only lets a
   user who is already signed in on this phone open the app with a biometric prompt.

   Store app (Capacitor): the prompt is checked by the OS and the Supabase refresh token is
   kept in the Keychain / Android Keystore, so the app can also restore a session that
   expired. Browser / home-screen app: WebAuthn on this device only. That is a lock screen
   for a shared phone, not a server-checked login (see docs/biometric-login-setup.md).

   Nothing secret is logged. No biometric data ever reaches the app or the server. */
"use strict";

const Bio = (() => {
  const KEY = "aarambh.bio", SERVER = "in.aarambh.preschool", LOCK_AFTER_MS = 60 * 1000;
  const cap = window.Capacitor, isNative = !!(cap && cap.isNativePlatform && cap.isNativePlatform());
  const plugin = () => (cap && cap.Plugins && cap.Plugins.NativeBiometric) || null;
  const bridge = () => Store.authBridge || null;

  const read = () => { try { const v = JSON.parse(localStorage.getItem(KEY) || "null"); return v && v.uid ? v : null; } catch { return null; } };
  const write = v => { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch { /* storage blocked: feature just stays off */ } };
  const wipeFlag = () => { try { localStorage.removeItem(KEY); } catch { /* ignore */ } };

  const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const unb64 = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
  const rand = n => crypto.getRandomValues(new Uint8Array(n));

  /* ---------- what this phone can do ---------- */
  async function supported() {
    if (isNative) {
      const p = plugin(); if (!p) return false;
      try { return !!(await p.isAvailable({ useFallback: true })).isAvailable; } catch { return false; }
    }
    try { return !!(window.PublicKeyCredential && PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable && await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()); }
    catch { return false; }
  }
  const enabledFor = uid => { const f = read(); return !!(f && f.uid === uid && f.mode === (isNative ? "native" : "web")); };
  const currentUid = () => (typeof S !== "undefined" && S.meId) || null;

  /* ---------- the OS prompt ---------- */
  async function prompt(flag) {
    if (flag.mode === "native") {
      const p = plugin(); if (!p) throw new Error("Biometric plugin is missing.");
      await p.verifyIdentity({ reason: "Unlock Aarambh", title: "Unlock Aarambh", useFallback: true, maxAttempts: 3 });
      return;
    }
    await navigator.credentials.get({ publicKey: {
      challenge: rand(32), timeout: 60000, userVerification: "required", rpId: location.hostname,
      allowCredentials: [{ type: "public-key", id: unb64(flag.cred) }]
    } });
  }

  /* ---------- turn on / off ---------- */
  async function enable() {
    const br = bridge(), { data } = br ? await br.getSession() : { data: {} };
    const session = data && data.session; if (!session) throw new Error("Log in first.");
    if (!(await supported())) throw new Error("This phone has no fingerprint, Face ID or screen lock set up.");
    const uid = session.user.id;
    if (isNative) {
      const p = plugin();
      await p.verifyIdentity({ reason: "Turn on biometric unlock", title: "Turn on biometric unlock", useFallback: true });
      await p.setCredentials({ username: uid, password: session.refresh_token, server: SERVER });
      write({ uid, mode: "native" });
    } else {
      const cred = await navigator.credentials.create({ publicKey: {
        challenge: rand(32), rp: { name: "Aarambh Pre School", id: location.hostname },
        user: { id: new TextEncoder().encode(uid), name: "aarambh-" + uid.slice(0, 8), displayName: "Aarambh" },
        pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
        authenticatorSelection: { authenticatorAttachment: "platform", userVerification: "required", residentKey: "discouraged" },
        timeout: 60000, attestation: "none"
      } });
      write({ uid, mode: "web", cred: b64(cred.rawId) });
    }
  }
  async function disable() {
    const f = read(); wipeFlag();
    if (f && f.mode === "native") { const p = plugin(); if (p) { try { await p.deleteCredentials({ server: SERVER }); } catch { /* nothing stored */ } } }
  }

  /* native: a refresh token is single-use, so keep the newest one in the Keychain */
  function keepTokenFresh() {
    const br = bridge(); if (!br || !isNative) return;
    br.onChange(async (_ev, session) => {
      const f = read(); if (!session || !f || f.mode !== "native" || f.uid !== session.user.id) return;
      const p = plugin(); if (!p) return;
      try { await p.setCredentials({ username: f.uid, password: session.refresh_token, server: SERVER }); } catch { /* retry on next refresh */ }
    });
  }

  /* ---------- lock screen ---------- */
  let overlay = null, busy = false, hiddenAt = 0;
  function lockUI(flag) {
    if (overlay) return;
    overlay = document.createElement("div");
    overlay.id = "bioLock"; overlay.setAttribute("role", "dialog"); overlay.setAttribute("aria-modal", "true"); overlay.setAttribute("aria-label", "App locked");
    overlay.innerHTML = `<div class="biobox"><img src="${typeof LOGO !== "undefined" ? LOGO : ""}" alt="" width="96" height="96"><h2>Aarambh is locked</h2>
      <p class="muted" id="bioMsg">Use your fingerprint, face or screen lock to open.</p>
      <button class="btn block" id="bioTry" type="button">Unlock</button>
      <button class="btn ghost block" id="bioPw" type="button" style="margin-top:10px">Use password instead</button></div>`;
    document.body.appendChild(overlay);
    overlay.querySelector("#bioTry").addEventListener("click", () => tryUnlock(flag));
    overlay.querySelector("#bioPw").addEventListener("click", async () => {   // forgot / lost biometric: back to the normal login
      await disable(); unlock();
      try { await Store.logoutNow(); } catch { /* already signed out */ }
    });
  }
  const unlock = () => { if (overlay) { overlay.remove(); overlay = null; } };
  async function tryUnlock(flag) {
    if (busy) return; busy = true;
    const msg = overlay && overlay.querySelector("#bioMsg");
    try {
      await prompt(flag);
      const br = bridge(); let session = br ? (await br.getSession()).data.session : null;
      if (!session && flag.mode === "native") {   // session expired while closed: restore it from the Keychain
        const c = await plugin().getCredentials({ server: SERVER });
        if (c && c.username === flag.uid) { const r = await br.restore(c.password); session = r.data && r.data.session; }
      }
      if (!session || session.user.id !== flag.uid) { await disable(); unlock(); return; }   // different or no account: normal login
      unlock();
    } catch {
      if (msg) msg.textContent = "Couldn't verify. Try again, or use your password.";
    } finally { busy = false; }
  }
  function lockIfEnabled() {
    const f = read(); if (!f || f.mode !== (isNative ? "native" : "web")) return;
    lockUI(f); tryUnlock(f);
  }

  /* lock on open, and again when the app was in the background for a minute */
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { hiddenAt = Date.now(); return; }
    if (hiddenAt && Date.now() - hiddenAt > LOCK_AFTER_MS) lockIfEnabled();
    hiddenAt = 0;
  });
  if (read()) lockIfEnabled();
  keepTokenFresh();

  return { supported, enabledFor, enable, disable, currentUid };
})();

/* ---------- My account card ---------- */
let bioOk = null;
if (typeof A !== "undefined") {
  Bio.supported().then(v => { bioOk = v; if (v && typeof scheduleRender === "function") scheduleRender(); });
  A.bioToggle = async () => {
    try {
      if (Bio.enabledFor(Bio.currentUid())) { await Bio.disable(); toast("Biometric unlock is off."); }
      else { await Bio.enable(); toast("Biometric unlock is on."); }
    } catch (e) {
      const m = String((e && e.message) || "");
      toast(/cancel|denied|not allowed|abort/i.test(m + " " + (e && e.name)) ? "Not turned on." : m || "Couldn't turn on biometric unlock.");
    }
    render(true);
  };
}
function bioCard() {
  if (!bioOk) return "";
  const on = Bio.enabledFor(Bio.currentUid());
  return `<div class="card"><div class="row"><div class="grow"><b>Biometric unlock</b><p class="small muted">${on ? "On. The app asks for your fingerprint, face or screen lock when you open it." : "Open the app with your fingerprint, face or screen lock instead of typing."}</p></div><button class="btn sm ${on ? "ghost" : ""}" data-act="bioToggle">${on ? "Turn off" : "Turn on"}</button></div></div>`;
}
