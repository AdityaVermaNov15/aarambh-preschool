// Supabase Edge Function: send a phone notification when a notice is posted.
// Triggered by a Database Webhook on INSERT into public.notices (README step 6).
// Uses the open Web Push standard (VAPID) — works for Android Chrome and
// iPhone Home Screen apps (iOS 16.4+). No Firebase or Google services needed.
import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
webpush.setVapidDetails(
  Deno.env.get("VAPID_SUBJECT") ?? "mailto:admin@example.com",
  Deno.env.get("VAPID_PUBLIC_KEY")!,
  Deno.env.get("VAPID_PRIVATE_KEY")!,
);

Deno.serve(async (req) => {
  if (req.headers.get("x-webhook-secret") !== Deno.env.get("WEBHOOK_SECRET")) {
    return new Response("forbidden", { status: 403 });
  }
  const body = await req.json();
  const n = body?.record?.data ?? {};

  const { data: members, error: e1 } = await sb.from("members").select("id, role, status");
  if (e1) return new Response(e1.message, { status: 500 });
  const roles = new Map(members.filter((m) => m.status === "approved").map((m) => [m.id, m.role]));
  const wants = (role: string) =>
    n.audience === "all" || role === "admin" ||
    (n.audience === "staff" && role === "staff") ||
    (n.audience === "parents" && role === "parent");

  const { data: subs, error: e2 } = await sb.from("push_subscriptions").select("endpoint, uid, sub");
  if (e2) return new Response(e2.message, { status: 500 });

  const payload = JSON.stringify({
    title: "Aarambh: " + (n.title ?? "New notice"),
    body: String(n.body ?? "").slice(0, 150),
    url: "./",
  });
  let sent = 0;
  const gone: string[] = [];
  await Promise.all(
    subs
      .filter((s) => s.uid !== n.by && roles.has(s.uid) && wants(roles.get(s.uid)!))
      .map(async (s) => {
        try {
          await webpush.sendNotification(s.sub, payload, { TTL: 86400 });
          sent++;
        } catch (err) {
          const code = (err as { statusCode?: number }).statusCode;
          if (code === 404 || code === 410) gone.push(s.endpoint); // phone unsubscribed
        }
      }),
  );
  if (gone.length) await sb.from("push_subscriptions").delete().in("endpoint", gone);
  return Response.json({ sent, removed: gone.length });
});
