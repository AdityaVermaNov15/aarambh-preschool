/* Aarambh Pre School — parent-reported student leave.
   A parent reports from home that their child will be on leave; teachers and the
   admin see it at once (live update in the app + phone alert). Loaded after the
   main app script and before app-supabase.js, which supplies Store.leave (the
   server calls). The checks themselves (is this your child, dates, reason, limits)
   run on the server in supabase/migrations/20261122000000_student_leave.sql. */
"use strict";

/* ---------- helpers ---------- */
const lvAll = () => Store.all("leaves");
const lvRange = l => l.from === l.to ? fmtDay(l.from) : fmtDay(l.from) + " – " + fmtDay(l.to);
/* the active leave that covers this child on this date, or null */
function leaveOn(studentId, date) {
  return lvAll().find(l => l.studentId === studentId && l.status === "active" && l.from <= date && date <= l.to) || null;
}
/* small line under a child's name on the attendance page */
function leaveTag(studentId, date) {
  const l = leaveOn(studentId, date);
  return l ? `<small>🏠 On leave (reported by parent)${l.reason ? ": " + esc(l.reason) : ""}</small>` : "";
}

/* ---------- Home card ---------- */
function leaveCard() {
  if (!Store.leave) return "";
  const t = today();
  if (role() === "parent") {
    const kids = myKids(); if (!kids.length) return "";
    const ids = new Set(kids.map(k => k.id));
    const mine = lvAll().filter(l => ids.has(l.studentId) && l.status === "active" && l.to >= t).sort((a, b) => a.from.localeCompare(b.from));
    const line = mine.length ? mine.slice(0, 2).map(l => `${esc((l.studentName || "").split(" ")[0])}: ${lvRange(l)}`).join("<br>") + (mine.length > 2 ? "<br>…" : "")
      : "Tell the teachers if your child will not come to school.";
    return `<div class="section" style="margin-top:10px"><div class="card daycard"><div><b>Child on leave?</b><div class="small" style="margin-top:2px">${line}</div></div>
      <div class="row" style="margin-top:10px;gap:8px"><button class="btn sun" data-act="leaveNew">🏠 Report leave</button><button class="btn ghost" data-act="go" data-v="leave">My requests</button></div></div></div>`;
  }
  if (!isStaff()) return "";
  const now = lvAll().filter(l => l.status === "active" && l.from <= t && l.to >= t);
  if (!now.length) return "";
  return `<div class="section" style="margin-top:10px"><button class="card daycard" style="width:100%;text-align:left;cursor:pointer" data-act="go" data-v="leaves">
    <b>🏠 On leave today (${now.length})</b><div class="small" style="margin-top:2px">${now.slice(0, 4).map(l => esc((l.studentName || "").split(" ")[0]) + " (" + esc(clsName(l.cls)) + ")").join(", ")}${now.length > 4 ? ", …" : ""}</div></button></div>`;
}

/* ---------- parent: report and cancel ---------- */
const LEAVE_WHY = ["Fever / not well", "Family function", "Travelling", "Other"];
A.leaveNew = () => {
  if (!Store.leave) return toast("Reporting leave works in the online app.");
  const kids = myKids(); if (!kids.length) return toast("No child is linked to your account yet.");
  const t = today();
  openSheet("Report leave",
    (kids.length > 1
      ? field("Child", `<select name="sid" required>${kids.map(k => `<option value="${esc(k.id)}" ${k.id === S.childId ? "selected" : ""}>${esc(k.name)} (${esc(clsName(k.cls))})</option>`).join("")}</select>`)
      : `<input type="hidden" name="sid" value="${esc(kids[0].id)}"><p style="margin-bottom:10px"><b>${esc(kids[0].name)}</b> · ${esc(clsName(kids[0].cls))}</p>`) +
    `<div class="row">${field("From", inp("from", t, "date", `required min="${t}"`))}${field("To", inp("to", t, "date", `required min="${t}"`))}</div>` +
    field("Reason", `<select name="why">${LEAVE_WHY.map(w => `<option>${w}</option>`).join("")}</select>`) +
    field("Note for the teacher (optional)", inp("note", "", "text", 'maxlength="100" placeholder="e.g. Doctor visit, back on Monday"')),
    async fd => {
      const sid = String(fd.get("sid") || ""), from = String(fd.get("from") || ""), to = String(fd.get("to") || "");
      if (!from || !to) throw new Error("Choose the leave dates.");
      if (from < today()) throw new Error("Leave can start today or later.");
      if (to < from) throw new Error("The \"To\" date must be on or after the \"From\" date.");
      const why = LEAVE_WHY.includes(fd.get("why")) ? fd.get("why") : "Other", note = String(fd.get("note") || "").trim().slice(0, 100);
      await Store.leave.apply(sid, from, to, note ? why + ": " + note : why);
      toast("Leave reported. The teachers have been told.");
    }, "Send to school");
};
A.leaveCancel = async d => {
  if (!confirm("Cancel this leave? The teachers will be told.")) return;
  try { await Store.leave.cancel(d.id); toast("Leave cancelled"); Store.leave.refresh(); } catch (e) { toast(friendlyError(e)); }
};

/* ---------- parent: my leave requests ---------- */
function viewLeave() {
  const head = pageHead("Leave requests", Store.leave ? `<button class="btn sm sun" data-act="leaveNew">+ Report</button>` : "");
  if (!Store.leave) return head + `<div class="section">${empty("Reporting leave works in the online app.")}</div>`;
  const t = today(), ids = new Set(myKids().map(k => k.id));
  const list = lvAll().filter(l => ids.has(l.studentId)).sort((a, b) => b.from.localeCompare(a.from)).slice(0, 40);
  return head + `<div class="section" style="margin-top:6px">${list.length ? `<ul class="list">${list.map(l => {
    const live = l.status === "active" && l.to >= t;
    const tag = l.status === "cancelled" ? `<span class="tag bad">Cancelled</span>` : l.to < t ? `<span class="tag">Done</span>` : l.from <= t ? `<span class="tag warn">Now</span>` : `<span class="tag ok">Upcoming</span>`;
    return `<li><span class="grow nm">${esc((l.studentName || "").split(" ")[0])} · ${lvRange(l)}<small>${esc(l.reason || "")}</small></span>${tag}${live ? `<button class="icon-btn" data-act="leaveCancel" data-id="${esc(l.id)}" aria-label="Cancel this leave">✕</button>` : ""}</li>`;
  }).join("")}</ul>` : empty("No leave reported yet.", `<button class="btn sun" data-act="leaveNew">Report a leave</button>`)}</div>`;
}

/* ---------- teachers and admin: who is on leave ---------- */
function viewLeaves() {
  const t = today();
  const live = lvAll().filter(l => l.status === "active" && l.to >= t).sort((a, b) => a.from.localeCompare(b.from) || String(a.studentName).localeCompare(String(b.studentName)));
  const row = l => { const s = Store.get("students", l.studentId);
    return `<li>${s ? avatar(s.name, s.photo) : avatar(l.studentName || "?")}<span class="grow nm">${esc(l.studentName || "Student")}<small>${esc(clsName(l.cls))} · ${lvRange(l)}</small><small>${esc(l.reason || "")} · reported by ${esc(l.byName || "parent")} ${l.createdAt ? ago(l.createdAt) : ""}</small></span></li>`; };
  const now = live.filter(l => l.from <= t), next = live.filter(l => l.from > t);
  return pageHead("Child leaves") + `<div class="section" style="margin-top:6px"><h2>On leave today (${now.length})</h2>${now.length ? `<ul class="list">${now.map(row).join("")}</ul>` : `<div class="card muted small">No child is on reported leave today.</div>`}</div>
    <div class="section"><h2>Coming up (${next.length})</h2>${next.length ? `<ul class="list">${next.map(row).join("")}</ul>` : `<div class="card muted small">No leave reported for the coming days.</div>`}</div>`;
}

/* ---------- live alert for teachers (called from onRemoteChange) ---------- */
function leaveRemote(snap) {
  if (!isStaff()) return;
  snap.docChanges().forEach(ch => {
    if (ch.type !== "added") return;
    const l = ch.doc.data();
    if (!l || l.status !== "active" || !l.createdAt || Date.now() - l.createdAt > 10 * 60e3) return;   // only fresh reports
    const msg = (l.studentName || "A child") + " (" + clsName(l.cls) + ") will be on leave " + lvRange(l);
    toast(msg);
    try { if ("Notification" in window && Notification.permission === "granted") new Notification("Aarambh: Leave reported", { body: msg, icon: LOGO }); } catch {}
  });
}

/* ---------- register the new pages ---------- */
VIEWS.leave = viewLeave;
VIEWS.leaves = viewLeaves;
ACCESS.leave = "parent";
ACCESS.leaves = "staff";
(MENU.find(g => g[0] === "Daily") || MENU[0])[1].push(["leave", "🏠", "Report leave"], ["leaves", "🏠", "Child leaves"]);
