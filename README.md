# Aarambh Pre School app

School app for **Aarambh Pre School** (auspices of R.L.J.D. Group), for Android and iPhone.

Parents, teachers and the admin use one app:

- **Home:** an Instagram-style feed of photos and videos with likes, and 24-hour stories.
- **Side menu:**
  - Student and staff attendance
  - Student accounts with photo (DP) and parent details
  - Meal planner and weekly planner
  - Date sheet
  - Notices, with phone alerts
  - Holidays and helpdesk
  - Stars & toppers
  - Admin approvals
- **Camera:** in-app photo and video recording, up to 1 minute with sound.
- **Classes:** Nursery, Play, LKG, UKG.

## Technology (all open source)

| Layer | Choice | Licence |
|---|---|---|
| **Database** | **PostgreSQL 15** | PostgreSQL Licence |
| **Backend** | **Supabase**: Auth (GoTrue), REST API (PostgREST), Realtime, Storage, Edge Functions (Deno). Use supabase.com or self-host with Docker. | Apache-2.0 / MIT |
| **Frontend** | Plain HTML, CSS and JavaScript, installable as a PWA. No build step is needed. | MIT |
| **Phone store apps** | Capacitor 6 wraps `www/` as Android and iOS apps. | MIT |
| **Phone alerts** | Web Push standard (VAPID) with the `web-push` library, with no Firebase or Google SDK. | MIT |

Security lives in the database. Row Level Security policies decide who can read and change each row. A trigger then limits which fields a non-admin can change:

- **Parents:** can change only their own child's parent details and photo. Can like only feed posts shared with their child's class.
- **Teachers:** cannot change roles or approvals.

## Folder structure

```
www/                      the app (this is what gets hosted / packaged)
  index.html              all screens
  app-supabase.js         connects the app to Supabase
  supabase-config.js      your project URL + keys   ← edit this
  sw.js                   offline start + phone notifications
  manifest.webmanifest    install on home screen
  icons/
supabase/
  migrations/20260929000000_init.sql   tables, RLS policies, triggers, storage bucket
  functions/notify/index.ts            sends phone alerts for new notices
assets/                   source icon + splash for the store apps
capacitor.config.json     Android/iOS app id and name
.github/workflows/pages.yml  auto-publish www/ to GitHub Pages
```

## Database design

Each screen's data lives in its own table. Each table has `id` plus a `data jsonb` document. Fields used for security and filtering are **generated columns**, so policies and indexes work on real columns.

| Table | One row per | Generated columns |
|---|---|---|
| `members` | app account (links to `auth.users`) | `role`, `status` |
| `students` | child: profile, father/mother details, fees, photo | `cls` |
| `att_students` | date + class (`2026-09-29_LKG`) | `cls`, `att_date` |
| `att_staff` | date | `att_date` |
| `meals`, `plans` | week (and class for plans) | — |
| `datesheet`, `holidays`, `toppers` | entry | — |
| `notices` | notice | `audience`, `created_by` |
| `tickets` | helpdesk request with replies | `created_by` |
| `gallery`, `stories` | post / story (file path in private bucket) | `cls`, `parents`, `created_by` |
| `push_subscriptions` | phone that turned on alerts | — |

Class codes: `NUR` = Nursery, `PG` = Play, `LKG`, `UKG`.

Partial updates go through `public.patch_doc()`, which does an atomic JSONB deep merge. For example, one parent's like never overwrites another parent's like.

## Setup (about 30 minutes)

### 1. Create the Supabase project

- **Hosted:** at supabase.com, create a free project. Region **Mumbai (ap-south-1)** is closest to Delhi.
- **Self-hosted:** follow Supabase's self-hosting guide (Docker Compose).

### 2. Connect the app

Open **Project Settings → API**. Put the **Project URL** and the **anon public key** in `www/supabase-config.js`. The anon key is meant to be public, because the RLS policies protect the data.

### 3. Sign-in settings

Open **Authentication → Providers → Email**:

- Keep Email **enabled**.
- Turn **Confirm email OFF.** People sign in with a mobile number and password. The app turns the number into an internal ID (`9876543210@phone.aarambh-app.in`), so no email or SMS is sent.

### 4. Create the database

Paste all of `supabase/migrations/20260929000000_init.sql` into **SQL Editor** and run it. It is safe to run again.

Or use the Supabase CLI:
```bash
supabase link --project-ref <your-ref>
supabase db push
```

### 5. Publish the app and make yourself admin

1. Push this repo to GitHub.
2. Go to **Settings → Pages → Source → GitHub Actions**.
3. Every push to `master` publishes `www/` to `https://adityavermanov15.github.io/aarambh-preschool/`.
4. Open that link and sign up with your own mobile number.
5. In the SQL Editor, make yourself admin (one time only):

```sql
update public.members
set data = data || '{"role":"admin","status":"approved"}'::jsonb
where id = (select id from auth.users where email = '9876543210@phone.aarambh-app.in');
```

After this, approve teachers and parents from the app's **Admin** screen, where you also link each parent to their child.

### 6. Phone alerts for new notices

1. Generate keys:
   ```bash
   npm run vapid
   ```
2. Put the **public** key in `www/supabase-config.js` as `VAPID_PUBLIC_KEY`.
3. Store the secrets and deploy the function:
   ```bash
   supabase secrets set VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=... \
     VAPID_SUBJECT=mailto:you@example.com WEBHOOK_SECRET=<any long random text>
   supabase functions deploy notify --no-verify-jwt
   ```
4. Go to **Database → Webhooks → Create** and fill in:
   - **Table:** `notices`
   - **Events:** Insert
   - **Type:** Supabase Edge Function, `notify`
   - **HTTP header:** `x-webhook-secret: <same WEBHOOK_SECRET>`

### 7. Install on phones (no app store needed)

- **Android (Chrome):** open the link, go to **Me → Install**, or use Chrome's menu → *Install app*.
- **iPhone (Safari):** open the link, tap **Share → Add to Home Screen**, then open Aarambh from the Home Screen.
  - Phone alerts on iPhone need iOS 16.4 or later.
  - They only work from the Home Screen app.

The camera, video recording, feed, stories and all screens work on both.

### 8. Optional: Play Store and App Store builds (Capacitor)

```bash
npm install
npx cap add android
npx cap add ios        # needs a Mac with Xcode
npm run icons          # app icon + splash from assets/
npm run android        # opens Android Studio
npm run ios            # opens Xcode
```

**Android:** add these to `android/app/src/main/AndroidManifest.xml`:
```xml
<uses-permission android:name="android.permission.CAMERA" />
<uses-permission android:name="android.permission.RECORD_AUDIO" />
<uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS" />
<uses-feature android:name="android.hardware.camera" android:required="false" />
```

**iPhone:** add these to `ios/App/App/Info.plist`. The app is rejected, or crashes on camera use, without them:
```xml
<key>NSCameraUsageDescription</key><string>Aarambh uses the camera to take photos and record videos of school activities.</string>
<key>NSMicrophoneUsageDescription</key><string>Aarambh records sound with class videos.</string>
<key>NSPhotoLibraryUsageDescription</key><string>Choose photos and videos to share with the school.</string>
```

**Costs:** Google Play charges a one-time USD 25. Apple Developer costs USD 99 per year.

**Push in store apps:** Web Push does not run inside store apps. Alerts there need Firebase Cloud Messaging on Android and APNs on iPhone. These are delivery services only; the database stays on PostgreSQL. Step 7 (install from the browser) gives alerts without them.

## Everyday admin tasks

**Reset a parent's password** in the SQL Editor:
```sql
update auth.users set encrypted_password = crypt('NewPass123', gen_salt('bf'))
where email = '9876543210@phone.aarambh-app.in';
```

**Back up the database:**
```bash
pg_dump "<connection string from Project Settings → Database>" > aarambh_backup.sql
```
Photos and videos are in Storage bucket `media`.

**See who's waiting for approval:**
```sql
select data->>'name', data->>'phone', role from public.members where status = 'pending';
```

## Known limits

- Parents can read their child's class attendance rows. Each row also holds classmates' present/absent marks. The app shows only their own child's marks.
- The app loads the last 120 days of attendance for staff screens. Older rows stay in the database.
- If a child moves to a different class, open that parent in **Admin** and press **Save** so their class access updates.
