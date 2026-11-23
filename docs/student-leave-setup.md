# Student leave (reported by parents) — setup

A parent reports from home that their child will be on leave. Teachers and the admin are told straight away.

## 1. Database (Supabase → SQL Editor)

Run `supabase/migrations/20261122000000_student_leave.sql` after the QR attendance script. It is safe to run more than once.

It adds the `leave_requests` table and two server functions:

| Function | Who | What it checks |
| --- | --- | --- |
| `apply_leave` | Parent | The child is linked to this parent; the leave starts today or later; at most 31 days; a reason is given; no overlap with an active leave; no more than 10 requests a day. |
| `cancel_leave` | The parent who reported it, or the admin | The leave has not ended yet. |

Parents cannot write to the table directly. Only the two functions above can, so every check runs on the server.
Teachers and the admin can read all leave requests; a parent can read only their own children's.

## 2. Publish the app

Push the `www/` folder as usual. New file: `www/leave.js`. The service worker cache name is now `aarambh-v5`, so phones pick up the new version on the next open.

## 3. Phone alerts to teachers (optional)

Uses the same Web Push keys as the `notify` function.

1. Deploy: `supabase functions deploy notify-leave --no-verify-jwt`
2. Supabase → **Database → Webhooks**: create two hooks on table `public.leave_requests`, type **Supabase Edge Functions**, function `notify-leave`, each with the HTTP header `x-webhook-secret` (same value as `WEBHOOK_SECRET`):
   - one for event **Insert** (leave reported)
   - one for event **Update** (leave cancelled)

Who is alerted: all admins, plus the teachers of the child's class. If no teacher is assigned to that class, every teacher is alerted.
The alert shows the child's first name, class and dates only. The reason stays inside the app.

Without this step the feature still works: teachers see the leave in the app straight away, and an open app shows a pop-up and a notification if they allowed alerts.

## How it works for people

- **Parent:** Home → **Report leave** (or menu → Report leave). Choose the child, dates and reason, then **Send to school**. **My requests** lists past and upcoming leaves; ✕ cancels one that has not ended.
- **Teacher / admin:** Home shows **On leave today** when a child is on leave. Menu → **Child leaves** lists today and coming days. On **Student attendance**, a child on leave shows "On leave (reported by parent)" under their name. Teachers still mark attendance as usual; the leave does not change saved marks.
- **Parent's Home** shows the child as "On leave" for the leave days if the teacher has not marked them yet.
