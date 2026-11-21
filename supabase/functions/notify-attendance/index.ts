// Supabase Edge Function: tell parents when their child's ID card is scanned.
// Triggered by a Database Webhook on INSERT into public.att_events
// (docs/qr-attendance-setup.md, step 5). Same Web Push setup as `notify`.
import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
webpush.setVapidDetails(
  Deno.env.get("VAPID_SUBJECT") ?? "mailto:admin@example.com",
  Deno.env.get("VAPID_PUBLIC_KEY")!,
  Deno.env.get("VAPID_PRIVATE_KEY")!,
);
const TZ = Deno.env.get("SCHOOL_TIME_ZONE") ?? "Asia/Kolkata";

Deno.serve(async (req) => {
  if (req.headers.get("x-webhook-secret") !== Deno.env.get("WEBHOOK_SECRET")) {
    return new Response("forbidden", { status: 403 });
  }
  const body = await req.json();
  const e = body?.record ?? {};
  if (e.kind !== "student") return Response.json({ skipped: "not a student scan" });

  const { data: st } = await sb.from("students").select("data").eq("id", e.subject_id).maybeSingle();
  const first = String(st?.data?.name ?? "Your child").split(" ")[0];
  const time = new Date(e.at).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: TZ });
  const text = e.direction === "in"
    ? `${first} reached school at ${time}.`
    : `${first} was picked up at ${time}${e.picked_up_by ? " by " + e.picked_up_by : ""}.`;

  // parents whose account is linked to this child
  const { data: parents, error: e1 } = await sb.from("members").select("id, data")
    .eq("role", "parent").eq("status", "approved").contains("data", { studentIds: [e.subject_id] });
  if (e1) return new Response(e1.message, { status: 500 });
  const uids = (parents ?? []).map((p) => p.id);
  if (!uids.length) return Response.json({ sent: 0 });

  const { data: subs, error: e2 } = await sb.from("push_subscriptions").select("endpoint, uid, sub").in("uid", uids);
  if (e2) return new Response(e2.message, { status: 500 });

  const payload = JSON.stringify({ title: "Aarambh: " + (e.direction === "in" ? "Arrived" : "Picked up"), body: text, url: "./" });
  let sent = 0;
  const gone: string[] = [];
  await Promise.all((subs ?? []).map(async (s) => {
    try {
      await webpush.sendNotification(s.sub, payload, { TTL: 3600 });
      sent++;
    } catch (err) {
      const code = (err as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) gone.push(s.endpoint);
    }
  }));
  if (gone.length) await sb.from("push_subscriptions").delete().in("endpoint", gone);
  return Response.json({ sent, removed: gone.length });
});
