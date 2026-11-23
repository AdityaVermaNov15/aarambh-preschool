/* Aarambh Pre School — QR attendance.
   Staff scan the office wall QR to check in and out; teachers scan children's
   ID cards at arrival and pickup; the admin sets the school location, prints
   the office poster and the ID cards. Loaded after the main app script and
   before app-supabase.js, which supplies Store.attendance (the server calls).
   The checks themselves (code, distance, phone, time) run on the server in
   supabase/migrations/20261121000000_qr_attendance.sql. */
"use strict";

const ATT_LIBS = {
  jsqr: "https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js",                 // reads QR codes from the camera
  qrgen: "https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js",       // draws QR codes for printing
  exceljs: "https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js"     // writes .xlsx files
};
const Att = { site: null, siteAsked: false, mode: null, session: [], inCards: false, pick: null, adm: null, flushing: false };
const Scan = { on: false, onCode: null, detector: null, busy: false, last: "", lastT: 0, cv: null };

/* ---------- small helpers ---------- */
const attScripts = {};
function attLoad(src) {
  if (!attScripts[src]) attScripts[src] = new Promise((res, rej) => {
    const s = document.createElement("script"); s.src = src; s.async = true;
    s.onload = res; s.onerror = () => { delete attScripts[src]; rej(new Error("Couldn't load the QR tool. Check your internet connection.")); };
    document.head.appendChild(s);
  });
  return attScripts[src];
}
function attClock(t) {
  try { return new Date(t).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: CFG.timeZone }).replace(/\s*([ap])\.?m\.?$/i, (_, x) => " " + x.toUpperCase() + "M"); }
  catch { const d = new Date(t); return z(d.getHours()) + ":" + z(d.getMinutes()); }
}
const attHM = hm => { if (!hm) return ""; const [h, m] = hm.split(":").map(Number); return ((h + 11) % 12 + 1) + ":" + z(m) + (h < 12 ? " AM" : " PM"); };
const attDur = ms => { const m = Math.max(0, Math.round(ms / 60000)); return Math.floor(m / 60) + " h " + (m % 60) + " m"; };
const attTok = t => String(t || "").replace(/(.{4})(?=.)/g, "$1 ");
const attNative = () => !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
function attStaffMark(uid, date) { const v = ((Store.raw("attStaff", date) || {}).marks || {})[uid]; return !v ? null : typeof v === "object" ? v : { k: v }; }
function attDeviceId() { let d = ls.get("device", null); if (!d) { d = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : newId() + newId(); ls.set("device", d); } return d; }
function attBuzz() {
  try { navigator.vibrate && navigator.vibrate(60); } catch {}
  try { const A = window.AudioContext || window.webkitAudioContext; if (!A) return; const ctx = attBuzz.ctx || (attBuzz.ctx = new A()); const o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.value = 1046; g.gain.value = 0.08; o.connect(g); g.connect(ctx.destination); o.start(); o.stop(ctx.currentTime + 0.09); } catch {}
}
function attLoadSite() {
  if (Att.siteAsked || !Store.attendance) return; Att.siteAsked = true;
  Store.attendance.siteInfo().then(s => { Att.site = s; scheduleRender(); }).catch(() => { Att.siteAsked = false; });
}
/* best GPS fix within a few seconds (the first fix on a phone is often rough) */
function attLocation(wait = 8000) {
  return new Promise((res, rej) => {
    if (!navigator.geolocation) return rej(new Error("Location isn't available on this device."));
    let best = null, id = null, done = false;
    const finish = () => { if (done) return; done = true; if (id != null) navigator.geolocation.clearWatch(id); clearTimeout(timer); best ? res(best) : rej(new Error("Couldn't find your location. Turn on GPS / Location and scan again.")); };
    const timer = setTimeout(finish, wait);
    id = navigator.geolocation.watchPosition(p => { if (!best || p.coords.accuracy < best.coords.accuracy) best = p; if (best.coords.accuracy <= 30) finish(); },
      e => { if (e.code === 1) { done = true; clearTimeout(timer); if (id != null) navigator.geolocation.clearWatch(id); rej(new Error("Location permission is off. Allow location for Aarambh in your phone settings, then scan again.")); } },
      { enableHighAccuracy: true, timeout: wait, maximumAge: 0 });
  });
}

/* ---------- Home: today's check-in card (staff and admin) ---------- */
function attCard() {
  if (!isStaff()) return "";
  attLoadSite(); attFlushQueue();
  const t = today(), m = attStaffMark(S.meId, t), site = Att.site;
  const inAt = m && m.k === "P" && m.at, outAt = m && m.out;
  let line, btn;
  if (m && m.k && m.k !== "P") { line = `Marked ${m.k === "A" ? "absent" : "on leave"} by the admin`; btn = `<button class="btn ghost" data-act="scanStaff">📷 Scan to check in</button>`; }
  else if (!inAt) { line = `<span class="muted">Not checked in</span>${site && site.open_time ? ` · School opens ${attHM(site.open_time)}` : ""}`; btn = `<button class="btn sun" data-act="scanStaff">📷 Scan to check in</button>`; }
  else if (!outAt) { line = `In <b>${attClock(inAt)}</b> · Out — · ${attDur(Date.now() - inAt)} so far`; btn = `<button class="btn" data-act="scanStaff">📷 Scan to check out</button>`; }
  else { line = `In <b>${attClock(inAt)}</b> · Out <b>${attClock(outAt)}</b> · ${attDur(outAt - inAt)}`; btn = `<button class="btn ghost" data-act="scanStaff">📷 Scan again</button>`; }
  const setup = isAdmin() && Store.attendance && site && !site.configured ? `<button class="btn ghost sm block" style="margin-top:8px" data-act="go" data-v="attSettings">📍 Set up QR attendance (school location and poster)</button>` : "";
  return `<div class="section" style="margin-top:10px"><div class="card daycard"><div><b>Today, ${fmtDay(t)}</b> ${m && m.late ? `<span class="tag warn">Late</span>` : ""}<div class="small" style="margin-top:2px">${line}</div></div>
    <div class="row" style="margin-top:10px;gap:8px">${btn}<button class="btn ghost" data-act="scanCards">🪪 Scan ID cards</button></div>${setup}</div></div>`;
}
/* "In 9:04 · Out 12:35 (Mother)" for a child's times object */
function attKidTimes(tm) {
  if (!tm || !tm.in && !tm.out) return "";
  return (tm.in ? "In " + attClock(tm.in) : "") + (tm.out ? (tm.in ? " · " : "") + "Out " + attClock(tm.out) + (tm.by ? " (" + tm.by + ")" : "") : "");
}
function attStaffTimes(v) {
  if (!v || typeof v !== "object") return "";
  return [v.at ? "In " + attClock(v.at) : "", v.out ? "Out " + attClock(v.out) : ""].filter(Boolean).join(" · ");
}

/* ---------- scanner (camera + QR reader) ---------- */
async function attOpenScanner(opt) {
  closeSheet(); closeCam();
  const c = $("#cam");
  c.innerHTML = `<div class="camtop"><button class="cbtn" data-act="camClose" aria-label="Close scanner">✕</button><b class="scantitle">${esc(opt.title)}</b><span style="width:42px"></span></div>${opt.top || ""}
  <div class="camstage"><video id="scanLive" playsinline muted autoplay></video><div class="scanframe" aria-hidden="true"></div></div>
  <div class="scanbar" id="scanBar" aria-live="polite">${opt.bar || `<p>${esc(opt.hint || "")}</p>`}</div>`;
  c.hidden = false; document.body.style.overflow = "hidden";
  Scan.onCode = opt.onCode; Scan.busy = false; Scan.last = "";
  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw Object.assign(new Error("unsupported"), { name: "NotSupported" });
    if (!Scan.detector && "BarcodeDetector" in window) {
      try { const f = await BarcodeDetector.getSupportedFormats(); if (f.includes("qr_code")) Scan.detector = new BarcodeDetector({ formats: ["qr_code"] }); } catch {}
    }
    const lib = Scan.detector ? null : attLoad(ATT_LIBS.jsqr);
    Cam.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
    const v = $("#scanLive"); if (!v) return attStopStream();
    v.srcObject = Cam.stream; v.play().catch(() => {});
    if (lib) await lib;
    Scan.on = true; attTick();
  } catch (e) { attScanFailed(e, opt); }
}
function attStopStream() { Scan.on = false; if (Cam.stream) { Cam.stream.getTracks().forEach(t => t.stop()); Cam.stream = null; } }
async function attTick() {
  if (!Scan.on) return;
  const v = $("#scanLive"); if (!v) { Scan.on = false; return; }
  if (!Scan.busy && v.readyState >= 2 && v.videoWidth) {
    let code = null;
    try {
      if (Scan.detector) { const r = await Scan.detector.detect(v); code = r && r[0] && r[0].rawValue; }
      else if (window.jsQR) {
        const w = Math.min(720, v.videoWidth), h = Math.round(v.videoHeight * w / v.videoWidth);
        const cv = Scan.cv || (Scan.cv = document.createElement("canvas")); cv.width = w; cv.height = h;
        const ctx = cv.getContext("2d", { willReadFrequently: true }); ctx.drawImage(v, 0, 0, w, h);
        const r = jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: "dontInvert" }); code = r && r.data;
      }
    } catch {}
    if (code && Scan.on && !(code === Scan.last && Date.now() - Scan.lastT < 4000)) {
      Scan.last = code; Scan.lastT = Date.now(); Scan.busy = true;
      try { await Scan.onCode(String(code).trim()); } catch (e) { attBar(`<div class="scanres bad"><p>${esc(friendlyError(e))}</p></div>` + attCardsControls()); }
      finally { Scan.busy = false; Scan.lastT = Date.now(); }
    }
  }
  if (Scan.on) setTimeout(attTick, 180);
}
const attBar = html => { const b = $("#scanBar"); if (b) b.innerHTML = html; };
function attScanFailed(e, opt) {
  closeCam();
  const denied = e && (e.name === "NotAllowedError" || e.name === "SecurityError");
  const msg = denied ? "Camera permission is blocked for Aarambh. Allow the camera in your phone settings (or the browser's site settings), then try again."
    : e && /QR tool/.test(e.message || "") ? e.message : "The camera isn't available here. Try the Aarambh app or Chrome on your phone.";
  openSheet("Can't open the scanner", `<p style="margin-bottom:14px">${esc(msg)}</p>` +
    (opt && opt.cards ? `<button class="btn block" data-act="typeCard">Type the code printed on the card</button>` : `<button class="btn block" data-act="askMark" data-why="${esc(msg)}">Ask the admin to mark me</button>`));
}

/* ---------- staff: check in / check out ---------- */
A.scanStaff = () => {
  if (!Store.attendance) return A.checkIn();             // on-device demo mode: old button
  const loc = attLocation(); loc.catch(() => {});        // start GPS while the camera opens
  Att.inCards = false;
  attOpenScanner({ title: "Scan the office QR", hint: "Point the camera at the Aarambh attendance poster in the school office.", onCode: async code => {
    if (/^AARAMBH:STU:/i.test(code)) { attBar(`<p>That's a child's ID card. For your own attendance, scan the poster in the office.</p>`); return; }
    if (!/^AARAMBH:SITE:/i.test(code)) { attBar(`<p>That's not the Aarambh attendance QR. Scan the poster in the office.</p>`); return; }
    attStopStream();
    attBar(`<div class="scanres"><div class="spin" aria-hidden="true"></div><p>Checking that you're at school…</p></div>`);
    try {
      const p = await loc;
      const r = await Store.attendance.scanStaff(code, p.coords.latitude, p.coords.longitude, p.coords.accuracy, attDeviceId());
      if (!r.already) attBuzz();
      Store.attendance.refresh("attStaff");
      const fl = r.flags || [];
      attBar(`<div class="scanres ok"><div class="big" aria-hidden="true">✓</div><h3>${esc(r.message || "Done")}</h3>
        ${fl.includes("new_device") ? `<p class="small">This phone is new for your account, so the admin will confirm it once.</p>` : ""}
        ${r.direction === "in" && !r.already ? `<p class="small">Scan the same QR again when you leave to check out.</p>` : ""}
        <button class="btn sun block" style="margin-top:12px" data-act="camClose">Done</button></div>`);
    } catch (e) {
      attBar(`<div class="scanres bad"><div class="big" aria-hidden="true">!</div><h3>${esc(friendlyError(e))}</h3>
        <div class="row" style="gap:8px;margin-top:12px"><button class="btn ghost grow" data-act="scanStaff">Try again</button><button class="btn grow" data-act="askMark" data-why="${esc(friendlyError(e))}">Ask admin to mark me</button></div></div>`);
    }
  } });
};
A.askMark = async d => {
  closeCam(); closeSheet();
  const id = newId(), why = d.why || "QR scan didn't work";
  try {
    await Store.set("tickets", id, { category: "General", subject: "Please mark my attendance for " + fmtDay(today()), body: "My QR check-in didn't work.\nReason shown: " + why + "\nTime: " + attClock(Date.now()),
      by: S.meId, status: "open", replies: [], createdAt: Date.now(), updatedAt: Date.now() });
    toast("Request sent to the admin");
  } catch (e) { toast(friendlyError(e)); }
};

/* ---------- teachers: scan children's ID cards ---------- */
const attModeSwitch = () => `<div class="scanmodes" role="group" aria-label="Scan for"><button class="${Att.mode === "in" ? "on" : ""}" data-act="scanMode" data-m="in">Arrival</button><button class="${Att.mode === "out" ? "on" : ""}" data-act="scanMode" data-m="out">Pickup</button></div>`;
function attCardsControls() {
  if (!Att.inCards) return "";
  const n = Att.session.length;
  return `${n ? `<p class="small" style="opacity:.85;margin-top:8px">${n} scanned: ${Att.session.slice(-4).map(esc).join(", ")}${n > 4 ? "…" : ""}</p>` : ""}
  <div class="row" style="gap:8px;justify-content:center;margin-top:10px"><button class="btn ghost sm" data-act="typeCard">Type card code</button><button class="btn sm" data-act="cardsDone">Finish</button></div>`;
}
const attCardsIdle = () => `<p>${Att.mode === "in" ? "Scan each child's card as they arrive." : "Scan the card when the child is picked up."}</p>` + attCardsControls();
A.scanCards = () => {
  if (!Store.attendance) return toast("ID card scanning works in the online app.");
  if (!Att.mode) {   // before 11 AM school time: arrivals; after: pickups
    let h = new Date().getHours();
    try { h = Number(new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hourCycle: "h23", timeZone: CFG.timeZone }).format(new Date())); } catch {}
    Att.mode = h >= 11 ? "out" : "in";
  }
  Att.session = []; Att.inCards = true;
  attOpenScanner({ title: "Scan ID cards", top: attModeSwitch(), bar: attCardsIdle(), cards: true, onCode: attOnCard });
};
A.scanMode = d => { Att.mode = d.m; document.querySelectorAll(".scanmodes button").forEach(b => b.classList.toggle("on", b.dataset.m === d.m)); if (Att.pick) { const r = Att.pick; Att.pick = null; r(null); } attBar(attCardsIdle()); };
async function attOnCard(code) {
  if (/^AARAMBH:SITE:/i.test(code)) { attBar(`<p>That's the office QR. For your own attendance, use "Scan to check in" on the Home screen.</p>` + attCardsControls()); return; }
  if (!/^AARAMBH:STU:/i.test(code)) { attBar(`<p>That's not an Aarambh ID card.</p>` + attCardsControls()); return; }
  let by = null;
  if (Att.mode === "out") { by = await attPickCollector(); if (by === null) { attBar(attCardsIdle()); return; } }
  await attSendCard(code, Att.mode, by);
  await new Promise(r => setTimeout(r, 900));          // keep the result on screen for a moment
}
function attPickCollector() {
  return new Promise(res => {
    Att.pick = res;
    attBar(`<h3 style="margin-bottom:10px">Who collected the child?</h3><div class="pickgrid">${["Father", "Mother", "Van / auto", "Other"].map(x => `<button class="btn ghost" data-act="pickBy" data-v="${x}">${x}</button>`).join("")}</div>
      <button class="btn sm ghost" style="margin-top:10px" data-act="pickBy" data-v="">Cancel</button>`);
  });
}
A.pickBy = d => {
  let v = d.v;
  if (v === "Other") { v = prompt("Name of the person collecting the child"); if (!v || !v.trim()) return; v = "Other: " + v.trim(); }
  const r = Att.pick; Att.pick = null; if (r) r(v || null);
};
async function attSendCard(code, mode, by) {
  try {
    const r = await Store.attendance.scanStudent(code, mode, by, null);
    const s = r.student || {};
    if (!r.duplicate) { Att.session.push(String(s.name || "").split(" ")[0]); attBuzz(); }
    Store.attendance.refresh("attStudents");
    attBar(`<div class="scanres ok"><div class="row" style="gap:12px;justify-content:center">${avatar(s.name, s.photo, true)}<div style="text-align:left"><h3>${esc(s.name)}</h3>
      <p>${esc(clsName(s.cls))} · ${mode === "in" ? "Arrived" : "Picked up"} ${attClock(r.at)}${by ? " · " + esc(by) : ""}</p>${r.duplicate ? `<p class="small">Already scanned</p>` : ""}</div></div></div>` + attCardsControls());
  } catch (e) {
    if (e.code === "offline") {
      const q = ls.get("scanq", []); q.push({ code, mode, by, t: Date.now() }); ls.set("scanq", q);
      Att.session.push("(saved)");
      attBar(`<div class="scanres warn"><p>No internet. Saved on this phone; it will be sent when you're back online.</p></div>` + attCardsControls());
    } else attBar(`<div class="scanres bad"><p>${esc(friendlyError(e))}</p></div>` + attCardsControls());
  }
}
async function attFlushQueue() {
  const q = ls.get("scanq", []);
  if (!q.length || Att.flushing || !Store.attendance || !navigator.onLine) return;
  Att.flushing = true; let sent = 0; const keep = [];
  for (const x of q) {
    try { await Store.attendance.scanStudent(x.code, x.mode, x.by, x.t); sent++; }
    catch (e) { if (e.code === "offline") keep.push(x); }
  }
  ls.set("scanq", keep); Att.flushing = false;
  if (sent) { toast(sent + " saved card scan" + (sent > 1 ? "s" : "") + " sent"); Store.attendance.refresh("attStudents"); }
}
window.addEventListener("online", () => attFlushQueue());
A.typeCard = () => {
  const v = prompt("Type the code printed under the QR on the ID card");
  if (!v || !v.trim()) return;
  if ($("#cam").hidden) { closeSheet(); A.scanCards(); setTimeout(() => attTyped(v), 400); } else attTyped(v);
};
async function attTyped(v) { Scan.busy = true; try { await attOnCard("AARAMBH:STU:" + v.trim()); } finally { Scan.busy = false; } }
A.cardsDone = () => {
  const n = Att.session.length; closeCam(); Att.inCards = false;
  if (n) toast(n + " card" + (n > 1 ? "s" : "") + " scanned");
  S.attDate = today(); go("studentAtt");
};

/* ---------- QR images and printing ---------- */
async function attQrSvg(text, ecl) {
  await attLoad(ATT_LIBS.qrgen);
  const q = qrcode(0, ecl || "M"); q.addData(text); q.make();
  const n = q.getModuleCount(), m = 4; let d = "";
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${c + m} ${r + m}h1v1h-1z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n + 2 * m} ${n + 2 * m}" shape-rendering="crispEdges" role="img" aria-label="QR code"><rect width="100%" height="100%" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}
async function attPrint(html) {
  let p = $("#printArea"); if (!p) { p = document.createElement("div"); p.id = "printArea"; document.body.appendChild(p); }
  p.innerHTML = html;
  await Promise.all([...p.querySelectorAll("img")].map(i => i.complete ? null : new Promise(r => { i.onload = i.onerror = r; })));
  if (attNative()) toast("If printing doesn't open, print from Chrome on a computer: open the app link and log in as admin.");
  setTimeout(() => window.print(), 50);
}
function attDownload(name, svg) {
  const a = document.createElement("a"); a.href = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
}
async function attPrintCards(list) {   // list: [{student_id, token}]
  const rows = list.map(c => ({ ...c, s: Store.get("students", c.student_id) })).filter(c => c.s);
  if (!rows.length) return toast("No students to print.");
  toast("Preparing " + rows.length + " card" + (rows.length > 1 ? "s" : "") + "…");
  const paths = rows.map(c => c.s.photo && c.s.photo.path).filter(Boolean);
  const urls = paths.length && Store.attendance.signNow ? await Store.attendance.signNow(paths) : {};
  const cards = await Promise.all(rows.map(async c => {
    const s = c.s, ph = s.photo ? (s.photo.path ? urls[s.photo.path] : mediaSrc(s.photo)) : "";
    return `<div class="idcard"><div class="idtop"><img src="${LOGO}" alt=""><div><b>AARAMBH</b><small>Pre School</small></div></div>
      <div class="idbody"><div class="idphoto">${ph ? `<img src="${esc(ph)}" alt="">` : `<span>${esc(initials(s.name))}</span>`}</div>
      <div class="idinfo"><b>${esc(s.name)}</b><span>${esc(clsName(s.cls))}</span>${s.admNo ? `<span>Adm. no. ${esc(s.admNo)}</span>` : ""}${CFG.schoolPhone ? `<span>School: ${esc(CFG.schoolPhone)}</span>` : ""}</div>
      <div class="idqr">${await attQrSvg("AARAMBH:STU:" + c.token, "M")}<small>${esc(attTok(c.token))}</small></div></div></div>`;
  }));
  attPrint(`<div class="idsheet">${cards.join("")}</div>`);
}
A.idCards = () => openSheet("Print ID cards", `<p class="small muted" style="margin-bottom:10px">Cards are 85.6 × 54 mm (standard ID size), 8 to an A4 page. Children without a card get one now; existing cards keep working.</p>` +
  field("Class", `<select name="cls"><option value="all">All classes</option>${CLASSES.map(c => `<option value="${c.id}" ${S.stuCls === c.id ? "selected" : ""}>${c.name}</option>`).join("")}</select>`),
  async fd => { const list = await Store.attendance.cardsForClass(fd.get("cls")); await attPrintCards(list); }, "Make cards and print");
A.replaceCard = async d => {
  const s = Store.get("students", d.id); if (!s) return;
  if (!confirm("Replace " + s.name + "'s ID card? The old card will stop working at once.")) return;
  try { const token = await Store.attendance.replaceCard(d.id); toast("New card made"); await attPrintCards([{ student_id: d.id, token }]); }
  catch (e) { toast(friendlyError(e)); }
};

/* ---------- admin: Attendance & QR settings ---------- */
async function attAdmLoad() {
  Att.adm = { loading: true };
  try {
    const [site, devices] = await Promise.all([Store.attendance.getSite(), Store.attendance.devices()]);
    Att.adm = { site, devices: devices || [] };
    if (site) Att.adm.svg = await attQrSvg("AARAMBH:SITE:" + site.id + ":" + site.qr_code, "H").catch(() => "");
  } catch (e) { Att.adm = { error: friendlyError(e) }; }
  render(true);
}
function viewAttSettings() {
  if (!Store.attendance) return pageHead("Attendance & QR") + `<div class="section">${empty("QR attendance works in the online app connected to Supabase.")}</div>`;
  if (!Att.adm) { attAdmLoad(); return pageHead("Attendance & QR") + `<div class="section">${empty("Loading…")}</div>`; }
  if (Att.adm.loading) return pageHead("Attendance & QR") + `<div class="section">${empty("Loading…")}</div>`;
  if (Att.adm.error || !Att.adm.site) return pageHead("Attendance & QR") + `<div class="section">${empty(esc(Att.adm.error || "Run the QR attendance script in Supabase first (see docs/qr-attendance-setup.md)."), `<button class="btn" data-act="attReload">Try again</button>`)}</div>`;
  const s = Att.adm.site, hm = t => String(t || "").slice(0, 5), has = s.lat != null && s.lng != null;
  const dev = Att.adm.devices;
  return pageHead("Attendance & QR") + `
  <div class="section" style="margin-top:6px"><h2>1. School location</h2><form class="card" data-form="attSite">
    <p class="small muted" style="margin-bottom:10px">Staff can check in only within the radius of this point. Stand inside the school and tap the button.</p>
    <button type="button" class="btn ghost block" data-act="attHere">📍 Use my current location</button>
    <div class="row" style="margin-top:10px">${field("Latitude", inp("lat", has ? s.lat : "", "number", 'step="any" required id="attLat"'))}${field("Longitude", inp("lng", has ? s.lng : "", "number", 'step="any" required id="attLng"'))}</div>
    ${has ? `<p class="small" style="margin:-4px 0 10px"><a href="https://maps.google.com/?q=${s.lat},${s.lng}" target="_blank" rel="noopener">Check this point on the map ↗</a></p>` : ""}
    <div class="row">${field("Allowed distance (metres)", inp("radius_m", s.radius_m, "number", 'min="20" max="2000" required'))}${field("GPS must be within (metres)", inp("max_accuracy_m", s.max_accuracy_m, "number", 'min="10" max="1000" required'))}</div>
    <h3 class="fh">Timings</h3>
    <div class="row">${field("School opens", inp("open_time", hm(s.open_time), "time", "required"))}${field("Late after", inp("late_after", hm(s.late_after), "time", "required"))}</div>
    <div class="row">${field("Check-in opens", inp("checkin_from", hm(s.checkin_from), "time", "required"))}${field("Check-in closes", inp("checkin_until", hm(s.checkin_until), "time", "required"))}</div>
    ${field("Earliest check-out (minutes after check-in)", inp("min_gap_min", s.min_gap_min, "number", 'min="0" max="600" required'))}
    <button class="btn sun block">Save settings</button></form></div>
  <div class="section"><h2>2. Office QR poster</h2><div class="card">
    ${has ? "" : `<p class="small" style="margin-bottom:8px"><span class="tag warn">Save the school location first</span></p>`}
    <div class="qrprev">${Att.adm.svg || ""}</div>
    <p class="small muted" style="margin:8px 0 10px">Print on A4, laminate (matte), and fix it at chest height near the office door. Keep it out of direct sun.</p>
    <div class="row" style="gap:8px"><button class="btn sun grow" data-act="attPoster">🖨️ Print poster</button><button class="btn ghost grow" data-act="attQrDownload">⬇️ Download QR</button></div>
    <button class="btn danger block" style="margin-top:10px" data-act="attRegen">Make a new QR (old poster stops working)</button></div></div>
  <div class="section"><h2>3. Student ID cards</h2><div class="card"><p class="small muted" style="margin-bottom:10px">Each card has the child's photo, name, class and a QR with a random code (no personal details inside the QR).</p><button class="btn block" data-act="idCards">🪪 Print ID cards</button></div></div>
  <div class="section"><h2>New phones to approve</h2>${dev.length ? `<ul class="list">${dev.map(x => `<li><div class="grow nm">${esc((Store.get("members", x.uid) || {}).name || "Staff member")}<small>First used ${fmtTime(Date.parse(x.first_seen))}</small></div><button class="btn sm" data-act="attDevOk" data-u="${x.uid}" data-d="${esc(x.device_id)}">Approve</button><button class="icon-btn" data-act="attDevNo" data-u="${x.uid}" data-d="${esc(x.device_id)}" aria-label="Reject">✕</button></li>`).join("")}</ul>` : `<div class="card muted small">No new phones. When a teacher checks in from a different phone, it shows here.</div>`}</div>
  <div class="section"><h2>Download attendance sheet</h2><form class="card" data-form="attExport">
    <p class="small muted" style="margin-bottom:10px">Excel file (.xlsx) with staff, student and full scan log sheets.</p>
    <div class="row">${field("From", inp("from", today().slice(0, 8) + "01", "date", `required max="${today()}"`))}${field("To", inp("to", today(), "date", `required max="${today()}"`))}</div>
    <button class="btn block">⬇️ Download .xlsx</button></form></div>
  <div class="section"><h2>Missed scans</h2><div class="card"><p class="small muted" style="margin-bottom:10px">Add a check-in or check-out someone forgot. The reason is saved with it.</p><button class="btn ghost block" data-act="attFix">Fix a missed scan</button></div></div>`;
}
A.attReload = () => { Att.adm = null; render(true); };
A.attHere = async (d, t) => {
  t.disabled = true; t.textContent = "Finding your location…";
  try {
    const p = await attLocation(10000);
    $("#attLat").value = p.coords.latitude.toFixed(6); $("#attLng").value = p.coords.longitude.toFixed(6);
    toast("Location found (accurate to about " + Math.round(p.coords.accuracy) + " m). Tap Save settings.");
  } catch (e) { toast(e.message); }
  finally { if (t.isConnected) { t.disabled = false; t.textContent = "📍 Use my current location"; } }
};
F.attSite = async fd => {
  const n = k => Number(fd.get(k)), row = { lat: n("lat"), lng: n("lng"), radius_m: n("radius_m"), max_accuracy_m: n("max_accuracy_m"), min_gap_min: n("min_gap_min") };
  ["open_time", "late_after", "checkin_from", "checkin_until"].forEach(k => row[k] = fd.get(k));
  if (!(Math.abs(row.lat) <= 90 && Math.abs(row.lng) <= 180) || (!row.lat && !row.lng)) throw new Error("Enter a valid latitude and longitude, or tap Use my current location.");
  if (row.checkin_from >= row.checkin_until) throw new Error("Check-in must open before it closes.");
  await Store.attendance.saveSite(row);
  Att.site = null; Att.siteAsked = false; toast("Attendance settings saved"); attAdmLoad();
};
A.attPoster = async () => {
  const s = Att.adm && Att.adm.site; if (!s) return;
  if (s.lat == null) return toast("Save the school location first.");
  const svg = await attQrSvg("AARAMBH:SITE:" + s.id + ":" + s.qr_code, "H");
  attPrint(`<div class="poster"><img class="plogo" src="${LOGO}" alt=""><h1>AARAMBH Pre School</h1><h2>Staff attendance</h2><div class="pqr">${svg}</div>
    <p class="pbig">Open the Aarambh app and tap <b>Scan to check in</b></p><p>Scan when you arrive and again when you leave.</p>
    <p class="psmall">Printed ${esc(fmtDate(today()))}. If this poster is damaged, ask the admin to print a new one.</p></div>`);
};
A.attQrDownload = async () => { const s = Att.adm && Att.adm.site; if (!s) return; attDownload("aarambh-office-qr.svg", await attQrSvg("AARAMBH:SITE:" + s.id + ":" + s.qr_code, "H")); };
A.attRegen = async () => {
  if (!confirm("Make a new office QR? The poster on the wall will stop working until you print and put up the new one.")) return;
  try { await Store.attendance.regenerate(); toast("New QR made. Print the new poster."); attAdmLoad(); } catch (e) { toast(friendlyError(e)); }
};
A.attDevOk = async d => { try { await Store.attendance.approveDevice(d.u, d.d); toast("Phone approved"); attAdmLoad(); } catch (e) { toast(friendlyError(e)); } };
A.attDevNo = async d => { if (!confirm("Reject this phone? Check-ins from it stay flagged.")) return; try { await Store.attendance.removeDevice(d.u, d.d); attAdmLoad(); } catch (e) { toast(friendlyError(e)); } };
A.attFix = () => openSheet("Fix a missed scan",
  field("Who", `<select name="who" required><optgroup label="Staff">${approvedStaff().map(m => `<option value="staff:${m.id}">${esc(m.name)}</option>`).join("")}</optgroup><optgroup label="Children">${students().map(s => `<option value="student:${s.id}">${esc(s.name)} (${esc(clsName(s.cls))})</option>`).join("")}</optgroup></select>`) +
  `<div class="row">${field("Date", inp("date", today(), "date", `required max="${today()}"`))}${field("Time", inp("time", "", "time", "required"))}</div>` +
  field("What was missed", `<select name="dir"><option value="in">Check-in / arrival</option><option value="out">Check-out / pickup</option></select>`) +
  field("Reason", inp("reason", "", "text", 'required placeholder="e.g. Phone battery was dead"')),
  async fd => { const [kind, id] = fd.get("who").split(":"); await Store.attendance.correct(kind, id, fd.get("date"), fd.get("dir"), fd.get("time"), fd.get("reason").trim());
    Store.attendance.refresh(kind === "staff" ? "attStaff" : "attStudents"); toast("Saved"); }, "Save");

/* ---------- admin: download attendance as .xlsx ---------- */
const ATT_FLAG_TEXT = { new_device: "New phone", no_device: "No phone ID", late_checkin: "Checked in after closing time",
  sent_late: "Sent from offline queue", no_arrival_scan: "No arrival scan" };
const attHM24 = ms => {
  try { return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: CFG.timeZone }).format(new Date(ms)); }
  catch { const d = new Date(ms); return z(d.getHours()) + ":" + z(d.getMinutes()); }
};
/* stops text such as "=HYPERLINK(...)" from being treated as a formula if the sheet is later saved as CSV */
const attSafe = v => (typeof v === "string" && /^[=+\-@\t\r]/.test(v)) ? "'" + v : v;

function attGroup(events) {              // one row per person per day: first "in", last "out"
  const staff = new Map(), kids = new Map();
  for (const e of events) {
    const map = e.kind === "staff" ? staff : kids, key = e.att_date + "|" + e.subject_id;
    let r = map.get(key);
    if (!r) map.set(key, r = { date: e.att_date, id: e.subject_id, cls: e.cls, in: null, out: null, by: "", flags: new Set(), manual: false });
    const t = Date.parse(e.at);
    if (e.direction === "in") { if (r.in === null || t < r.in) r.in = t; }
    else if (r.out === null || t > r.out) { r.out = t; r.by = e.picked_up_by || ""; }
    (e.flags || []).forEach(f => r.flags.add(f));
    if (e.method === "manual") r.manual = true;
  }
  return { staff: [...staff.values()], kids: [...kids.values()] };
}
function attSheet(wb, name, cols, rows) {
  const ws = wb.addWorksheet(name, { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = cols.map(([header, key, width]) => ({ header, key, width }));
  rows.forEach(r => ws.addRow(Object.fromEntries(Object.entries(r).map(([k, v]) => [k, attSafe(v)]))));
  const h = ws.getRow(1); h.font = { bold: true, color: { argb: "FFFFFFFF" } };
  h.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF5B3FA0" } };
  ws.autoFilter = { from: "A1", to: { row: 1, column: cols.length } };
  return ws;
}
async function attExportXlsx(from, to) {
  const [events] = await Promise.all([Store.attendance.events(from, to), attLoad(ATT_LIBS.exceljs)]);
  if (!events.length) throw new Error("No attendance records between those dates.");
  const lateAfter = String(((Att.adm || {}).site || {}).late_after || "").slice(0, 5);
  const { staff, kids } = attGroup(events);
  const fl = r => [...r.flags].map(f => ATT_FLAG_TEXT[f] || f).join(", ");
  const hrs = r => r.in && r.out ? Math.round((r.out - r.in) / 36000) / 100 : "";
  const nameOf = (coll, id, fallback) => (Store.get(coll, id) || {}).name || fallback;

  const staffRows = staff.map(r => ({ date: r.date, name: nameOf("members", r.id, "Removed staff"),
    in: r.in ? attClock(r.in) : "", out: r.out ? attClock(r.out) : "", hours: hrs(r),
    late: r.in && lateAfter && attHM24(r.in) > lateAfter ? "Yes" : "", how: r.manual ? "Corrected by admin" : "QR", flags: fl(r) }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
  const kidRows = kids.map(r => ({ date: r.date, cls: clsName(r.cls), name: nameOf("students", r.id, "Removed student"),
    in: r.in ? attClock(r.in) : "", out: r.out ? attClock(r.out) : "", by: r.by, flags: fl(r) }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.cls.localeCompare(b.cls) || a.name.localeCompare(b.name));
  const logRows = events.map(e => ({ date: e.att_date, time: attClock(Date.parse(e.at)), kind: e.kind === "staff" ? "Staff" : "Student",
    name: e.kind === "staff" ? nameOf("members", e.subject_id, "Removed staff") : nameOf("students", e.subject_id, "Removed student"),
    dir: e.direction === "in" ? (e.kind === "staff" ? "Check-in" : "Arrival") : (e.kind === "staff" ? "Check-out" : "Pickup"),
    how: e.method === "manual" ? "Corrected by admin" : "QR", by: e.picked_up_by || "", flags: (e.flags || []).map(f => ATT_FLAG_TEXT[f] || f).join(", "), note: e.note || "" }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time));

  const wb = new ExcelJS.Workbook(); wb.creator = "Aarambh Pre School"; wb.created = new Date();
  attSheet(wb, "Staff", [["Date", "date", 12], ["Name", "name", 26], ["In", "in", 11], ["Out", "out", 11], ["Hours", "hours", 9], ["Late", "late", 7], ["Marked by", "how", 20], ["Flags", "flags", 34]], staffRows);
  attSheet(wb, "Students", [["Date", "date", 12], ["Class", "cls", 14], ["Name", "name", 26], ["Arrival", "in", 11], ["Pickup", "out", 11], ["Picked up by", "by", 20], ["Flags", "flags", 34]], kidRows);
  attSheet(wb, "Log", [["Date", "date", 12], ["Time", "time", 11], ["Type", "kind", 9], ["Name", "name", 26], ["Event", "dir", 11], ["Marked by", "how", 20], ["Picked up by", "by", 18], ["Flags", "flags", 30], ["Admin's reason", "note", 36]], logRows);

  const buf = await wb.xlsx.writeBuffer();
  const url = URL.createObjectURL(new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
  const a = document.createElement("a"); a.href = url; a.download = `aarambh-attendance_${from}_to_${to}.xlsx`;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 10000);
}
F.attExport = async fd => {
  if (!isAdmin()) throw new Error("Only the admin can download attendance.");
  const from = String(fd.get("from") || ""), to = String(fd.get("to") || ""), ymd = /^\d{4}-\d{2}-\d{2}$/;
  if (!ymd.test(from) || !ymd.test(to)) throw new Error("Choose both dates.");
  if (from > to) throw new Error("'From' must be on or before 'To'.");
  if (to > today()) throw new Error("'To' can't be in the future.");
  if ((Date.parse(to) - Date.parse(from)) / 864e5 > 366) throw new Error("Choose 12 months or less.");
  toast("Preparing the sheet…");
  await attExportXlsx(from, to);
  toast("Attendance sheet downloaded");
};

/* ---------- register the new page ---------- */
VIEWS.attSettings = viewAttSettings;
ACCESS.attSettings = "admin";
(MENU.find(g => g[0] === "School office") || MENU[MENU.length - 1])[1].push(["attSettings", "📍", "Attendance & QR"]);
