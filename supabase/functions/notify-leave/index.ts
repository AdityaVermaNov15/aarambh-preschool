// Supabase Edge Function: tell teachers and the admin when a parent reports (or cancels) a leave.
// Triggered by Database Webhooks on INSERT and UPDATE of public.leave_requests
// (docs/student-leave-setup.md). Same Web Push setup as `notify`.
// The alert names the child, class and dates only. The reason (which may be health
// information) stays inside the app and is not sent through the push service.
import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
webpush.setVapidDetails(
  Deno.env.get("VAPID_SUBJECT") ?? "mailto:admin@example.com",
  Deno.env.get("VAPID_PUBLIC_KEY")!,
  Deno.env.get("VAPID_PRIVATE_KEY")!,
);

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const day = (iso: string) =>
  ISO.test(iso)
    ? new Date(iso + "T00:00:00Z").toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" })
    : "";

Deno.serve(async (req) => {
  if (req.headers.get("x-webhook-secret") !== Deno.env.get("WEBHOOK_SECRET")) {
    return new Response("forbidden", { status: 403 });
  }
  const body = await req.json();
  const l = body?.record?.data ?? {};
  const was = body?.old_record?.data ?? {};

  let cancelled: boolean;
  if (body?.type === "INSERT" && l.status === "active") cancelled = false;
  else if (body?.type === "UPDATE" && l.status === "cancelled" && was.status === "active") cancelled = true;
  else return Response.json({ skipped: "nothing to announce" });

  const first = String(l.studentName ?? "A child").split(" ")[0].slice(0, 40);
  const cls = String(l.cls ?? "").slice(0, 20);
  const from = day(String(l.from ?? "")), to = day(String(l.to ?? ""));
  const range = !from ? "" : from === to || !to ? from : `${from} to ${to}`;
  const text = cancelled
    ? `${first}${cls ? " (" + cls + ")" : ""}: the leave for ${range} was cancelled.`
    : `${first}${cls ? " (" + cls + ")" : ""} will be on leave ${range}.`;

  // admins, plus teachers of that class (or every teacher if nobody is assigned to the class)
  const { data: staff, error: e1 } = await sb.from("members").select("id, role, data")
    .eq("status", "approved").in("role", ["admin", "staff"]);
  if (e1) return new Response(e1.message, { status: 500 });
  const teachers = (staff ?? []).filter((m) => m.role === "staff");
  const ofClass = teachers.filter((m) => Array.isArray(m.data?.classes) && m.data.classes.includes(l.cls));
  const uids = [
    ...(staff ?? []).filter((m) => m.role === "admin").map((m) => m.id),
    ...(ofClass.length ? ofClass : teachers).map((m) => m.id),
  ];
  if (!uids.length) return Response.json({ sent: 0 });

  const { data: subs, error: e2 } = await sb.from("push_subscriptions").select("endpoint, uid, sub").in("uid", uids);
  if (e2) return new Response(e2.message, { status: 500 });

  const payload = JSON.stringify({ title: "Aarambh: " + (cancelled ? "Leave cancelled" : "Leave reported"), body: text, url: "./" });
  let sent = 0;
  const gone: string[] = [];
  await Promise.all((subs ?? []).map(async (s) => {
    try {
      await webpush.sendNotification(s.sub, payload, { TTL: 86400 });
      sent++;
    } catch (err) {
      const code = (err as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) gone.push(s.endpoint);
    }
  }));
  if (gone.length) await sb.from("push_subscriptions").delete().in("endpoint", gone);
  return Response.json({ sent, removed: gone.length });
});
