/* Aarambh Pre School — Supabase (PostgreSQL) backend for the phone app.
   Loaded after the main app script. Replaces the on-device demo storage with
   Supabase Auth, the PostgreSQL tables in supabase/migrations, private file
   storage and live updates; adds "install app" and Web Push phone alerts. */
(function () {
  "use strict";
  const URL_ = window.SUPABASE_URL, KEY = window.SUPABASE_ANON_KEY;
  if (!window.supabase || !URL_ || !KEY || /PASTE/.test(URL_ + KEY)) {
    document.getElementById("app").innerHTML = '<div class="auth"><h1>Setup needed</h1><p class="sub">Add your Supabase URL and anon key to <b>www/supabase-config.js</b>. See README.md, step 2.</p></div>';
    return;
  }
  const sb = window.supabase.createClient(URL_, KEY, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false } });

  const TABLE = { attStudents: "att_students", attStaff: "att_staff" };
  const tbl = c => TABLE[c] || c;
  const COLL = Object.fromEntries(COLLS.map(c => [tbl(c), c]));
  const EMAIL_DOMAIN = "@phone.aarambh-app.in";   // the mobile number is the login ID
  const PIXEL = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
  const phoneToEmail = e => String(e).replace(/\D/g, "") + EMAIL_DOMAIN;   // +919876543210 → 919876543210@…
  const clean = o => JSON.parse(JSON.stringify(o));
  const fail = e => { throw Object.assign(new Error(e.message || "Request failed"), { code: e.code === "42501" ? "permission-denied" : e.code }); };
  const isNative = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const standalone = () => window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  const approvedNow = () => { const m = me(); return !!(m && m.status === "approved"); };

  /* ---------- data adapter ---------- */
  Store.mode = "server";
  COLLS.forEach(c => Store.data[c] = {});
  const localSet = (c, id, obj) => { Store.data[c] = { ...Store.data[c], [id]: obj }; scheduleRender(); };
  Store.set = async (c, id, o) => {
    const data = clean(o);
    const { error } = await sb.from(tbl(c)).upsert({ id, data });
    if (error) fail(error);
    localSet(c, id, data); queueRefetch(c);
  };
  Store.patch = async (c, id, part) => {
    const p = clean(part);
    const { error } = await sb.rpc("patch_doc", { p_table: tbl(c), p_id: id, p_part: p });
    if (error) fail(error);
    const cur = Store.raw(c, id);
    localSet(c, id, deepMerge(cur ? clean(cur) : {}, p)); queueRefetch(c);
  };
  Store.del = async (c, id) => {
    const { error } = await sb.from(tbl(c)).delete().eq("id", id);
    if (error) fail(error);
    const o = { ...Store.data[c] }; delete o[id]; Store.data[c] = o; scheduleRender(); queueRefetch(c);
  };

  /* ---------- photos and videos (private bucket + signed links) ---------- */
  Store.uploadMedia = async (file, maxDim, isVideo) => {
    const blob = isVideo ? file : await shrink(file, maxDim, 0.85, "blob");
    if (blob.size > 50 * 1024 * 1024) throw new Error("That file is over 50 MB. Record a shorter video.");
    const type = (blob.type || (isVideo ? "video/mp4" : "image/jpeg")).split(";")[0];
    const ext = ({ "image/jpeg": "jpg", "image/png": "png", "video/quicktime": "mov", "video/mp4": "mp4", "video/webm": "webm" })[type] || "bin";
    const path = `${S.meId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const b = document.querySelector("#sheetForm button.sun"); if (b) b.textContent = isVideo ? "Uploading video…" : "Uploading…";
    const { error } = await sb.storage.from("media").upload(path, blob, { contentType: type, upsert: false });
    if (error) fail(error);
    return { path, kind: isVideo ? "video" : "image" };
  };
  Store.removeMedia = path => sb.storage.from("media").remove([path]).catch(() => {});
  const signed = {}, signQueue = new Set(); let signTimer = 0;
  Store.signUrl = path => {
    const s = signed[path];
    if (s && s.exp > Date.now()) return s.url;
    signQueue.add(path);
    if (!signTimer) signTimer = setTimeout(flushSign, 20);
    return s ? s.url : PIXEL;
  };
  async function flushSign() {
    signTimer = 0;
    const paths = [...signQueue]; signQueue.clear(); if (!paths.length) return;
    const { data, error } = await sb.storage.from("media").createSignedUrls(paths, 86400);
    const now = Date.now();
    paths.forEach(p => { if (!signed[p]) signed[p] = { url: PIXEL, exp: now + 60000 }; });   // retry failed links in a minute
    if (!error && data) data.forEach(d => { if (d.signedUrl && d.path) signed[d.path] = { url: d.signedUrl, exp: now + 23 * 3600e3 }; });
    scheduleRender();
  }

  /* ---------- loading + live updates ---------- */
  let loadKey = "", channel = null;
  const pending = {};
  async function fetchAll(c) {
    const out = {}; let from = 0;
    for (;;) {
      let q = sb.from(tbl(c)).select("id,data").range(from, from + 999);
      if ((c === "attStudents" || c === "attStaff") && isStaff()) q = q.gte("att_date", addDays(today(), -120));
      const { data, error } = await q;
      if (error) { console.warn("[load " + c + "]", error); Store.loaded.add(c); scheduleRender(); return; }
      data.forEach(r => { out[r.id] = r.data; });
      if (data.length < 1000) break;
      from += 1000;
    }
    const prev = Store.data[c] || {}, first = !Store.loaded.has(c);
    Store.data[c] = out; Store.loaded.add(c);
    if (!first) {
      const added = Object.keys(out).filter(id => !prev[id]);
      if (added.length) onRemoteChange(c, { docChanges: () => added.map(id => ({ type: "added", doc: { data: () => out[id] } })) });
    }
    scheduleRender();
  }
  const meKey = () => { const m = me(); return m ? [m.status, m.role, (m.studentIds || []).join(","), (m.classes || []).join(",")].join("|") : "none"; };
  async function checkMe() {
    const k = meKey(); if (k === loadKey) return; loadKey = k;
    const rest = COLLS.filter(c => c !== "members");
    rest.forEach(c => { Store.data[c] = {}; Store.loaded.delete(c); });
    if (approvedNow()) {
      await fetchAll("members");            // approval widens what this person may read
      await Promise.all(rest.map(fetchAll));
    } else rest.forEach(c => Store.loaded.add(c));
    scheduleRender();
  }
  function queueRefetch(c) {
    clearTimeout(pending[c]);
    pending[c] = setTimeout(() => {
      if (!S.meId) return;
      if (c === "members") fetchAll("members").then(checkMe);
      else if (approvedNow()) fetchAll(c);
    }, 250);
  }
  function startRealtime() {
    stopRealtime();
    channel = sb.channel("aarambh-db")
      .on("postgres_changes", { event: "*", schema: "public" }, p => { const c = COLL[p.table]; if (c) queueRefetch(c); })
      .subscribe();
  }
  function stopRealtime() { if (channel) { sb.removeChannel(channel); channel = null; } }
  document.addEventListener("visibilitychange", () => {   // phones pause apps; catch up when reopened
    if (document.hidden || !S.meId) return;
    fetchAll("members").then(checkMe).then(() => { if (approvedNow()) COLLS.filter(c => c !== "members").forEach(fetchAll); });
  });

  /* ---------- sign in / out ---------- */
  async function onSession(session) {
    stopRealtime(); loadKey = "";
    COLLS.forEach(c => Store.data[c] = {});
    Store.loaded = new Set();
    if (!session) { S.meId = null; S.view = "home"; Store.loaded.add("members"); S.ready = true; render(true); return; }
    S.meId = session.user.id; S.ready = true; render(true);
    await fetchAll("members");
    await checkMe();
    startRealtime();
    setTimeout(() => { if (me()) cleanupStories(); }, 8000);
  }
  let curUid;
  sb.auth.onAuthStateChange((_ev, session) => {
    const uid = session ? session.user.id : null;
    if (uid === curUid) return;
    curUid = uid;
    setTimeout(() => onSession(session), 0);   // don't call Supabase inside this callback
  });

  const authMsg = e => {
    const m = String((e && (e.code || "") + " " + (e.message || "")) || "").toLowerCase();
    if (m.includes("already")) return "An account with this mobile number already exists. Log in instead.";
    if (m.includes("invalid") && (m.includes("login") || m.includes("credential"))) return "Mobile number or password is wrong.";
    if (m.includes("password")) return "Use a password with at least 6 characters.";
    if (m.includes("rate") || m.includes("too many")) return "Too many tries. Wait a few minutes and try again.";
    if (m.includes("fetch") || m.includes("network")) return "No internet connection.";
    return (e && e.message) || "Something went wrong. Try again.";
  };
  F.signup = async fd => {
    const name = fd.get("name").trim(), phone = e164(fd.get("cc"), fd.get("phone"));
    const { data, error } = await sb.auth.signUp({ email: phoneToEmail(phone), password: fd.get("pass") });
    if (error) throw new Error(authMsg(error));
    if (!data.session) throw new Error("Sign-up needs “Confirm email” turned off in Supabase (README step 3).");
    const uid = data.user.id;
    const role = fd.get("role") === "staff" ? "staff" : "parent";
    const doc = { name, phone, role, status: "pending", studentIds: [], createdAt: Date.now() };
    if (fd.get("consent")) doc.consentAt = Date.now();
    if (role === "parent") { doc.childName = (fd.get("childName") || "").trim(); doc.childCls = fd.get("childCls"); }
    const { error: e2 } = await sb.from("members").insert({ id: uid, data: doc });
    if (e2) fail(e2);
    Store.data.members = { ...Store.data.members, [uid]: doc }; Store.loaded.add("members");
    queueRefetch("members"); render(true);
  };
  F.login = async fd => {
    const { error } = await sb.auth.signInWithPassword({ email: phoneToEmail(e164(fd.get("cc"), fd.get("phone"))), password: fd.get("pass") });
    if (error) throw new Error(authMsg(error));
  };
  A.logout = async () => { closeMenu(); await sb.auth.signOut(); };
  Store.deleteAccount = async () => {
    const { error } = await sb.rpc("delete_my_account");
    if (error) throw new Error(error.message);
    await sb.auth.signOut().catch(() => {});
  };

  /* ---------- install to home screen ---------- */
  let installPrompt = null;
  window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); installPrompt = e; scheduleRender(); });
  window.installCard = () => {
    if (isNative || standalone()) return "";
    if (installPrompt) return `<div class="card row"><div class="grow"><b>Install the app</b><p class="small muted">Add Aarambh to your home screen and open it like any other app.</p></div><button class="btn sm sun" data-act="install">Install</button></div>`;
    if (isIOS) return `<div class="card"><b>Install on iPhone</b><p class="small muted">In Safari, tap the Share button, then “Add to Home Screen”. On iPhone, phone alerts work only after this.</p></div>`;
    return "";
  };
  A.install = async () => { if (!installPrompt) return; installPrompt.prompt(); await installPrompt.userChoice.catch(() => {}); installPrompt = null; render(true); };

  /* ---------- phone alerts (Web Push, open standard) ---------- */
  if ("serviceWorker" in navigator && location.protocol === "https:" && !isNative) {
    navigator.serviceWorker.register("sw.js").catch(e => console.warn("service worker", e));
  }
  const b64ToBytes = s => { const p = "=".repeat((4 - s.length % 4) % 4); const raw = atob((s + p).replace(/-/g, "+").replace(/_/g, "/")); return Uint8Array.from(raw, c => c.charCodeAt(0)); };
  A.notifyOn = async () => {
    if (isNative) return toast("Phone alerts in the store app need the extra setup in README step 8.");
    if (isIOS && !standalone()) return toast("On iPhone, first add the app to your Home Screen (Share → Add to Home Screen), then turn on alerts there.");
    if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return toast("This browser doesn't support alerts. Use Chrome on Android, or the Home Screen app on iPhone.");
    if (!window.VAPID_PUBLIC_KEY || /PASTE/.test(window.VAPID_PUBLIC_KEY)) return toast("Phone alerts aren't set up yet (README step 6).");
    const perm = await Notification.requestPermission();
    if (perm !== "granted") return toast("Alerts are blocked. Allow notifications for Aarambh in your phone settings.");
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(window.VAPID_PUBLIC_KEY) });
      const { error } = await sb.from("push_subscriptions").upsert({ endpoint: sub.endpoint, uid: S.meId, sub: sub.toJSON(), platform: isIOS ? "ios" : /android/i.test(navigator.userAgent) ? "android" : "web" });
      if (error) fail(error);
      toast("Phone alerts are on.");
    } catch (e) { console.warn(e); toast("Couldn't turn on alerts: " + friendlyError(e)); }
  };
})();
