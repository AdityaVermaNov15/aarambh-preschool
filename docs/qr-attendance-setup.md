# QR attendance — setup

Staff check in and out by scanning the QR poster in the office. Teachers scan children's ID cards at arrival and pickup. Parents get a phone alert for each scan.

Design: [QR check-in / check-out system design](https://claude.ai/artifact/A5kRrJHgp2VbvC2tYddmjL).

## 1. Database (Supabase → SQL Editor)

1. If the first script (`supabase/migrations/20260929000000_init.sql`) ever failed with `operator does not exist: text = text[]`, run the fixed version of that file again. It is safe to re-run.
2. Open **SQL Editor → New query**, paste all of `supabase/migrations/20261121000000_qr_attendance.sql`, and press **Run**. It is safe to run more than once.

This adds:

| Table | Holds |
| --- | --- |
| `att_sites` | School location, allowed distance, timings and the secret office QR code. Only the admin can read it. |
| `id_cards` | One active card code per child; lost cards are marked replaced. Admin only. |
| `att_events` | Every scan and correction, with server time. Nobody can edit or delete rows. |
| `staff_devices` | The phone each staff member checks in from. New phones are flagged for the admin. |

And the server functions `scan_staff`, `scan_student`, `admin_correct`, `att_site_info`, `att_regenerate_code`, `id_cards_for_class` and `replace_id_card`.

## 2. Publish the app

Push the `www/` folder as you do today (GitHub Pages workflow). The new file is `www/attendance.js`. The service worker cache name changed to `aarambh-v3`, so phones pick up the new version on the next open.

The scanner loads two small open-source libraries from jsDelivr only when needed: `jsqr` (reads QR codes) and `qrcode-generator` (draws them for printing).

## 3. Admin: one-time setup in the app

1. Log in as admin. Open the menu → **School office → Attendance & QR**.
2. Stand inside the school and tap **Use my current location**, then **Save settings**. Check the point with **Check this point on the map**.
3. Adjust the timings if needed (defaults: school opens 9:00 AM, late after 9:15 AM, check-in 6:00 AM–12:00 PM, check-out at least 30 minutes after check-in, allowed distance 150 m).
4. Tap **Print poster**. Print on A4, laminate (matte) and fix at chest height near the office door. Printing works best from Chrome on a computer.
5. **Print ID cards**: from the same page or **Students → 🪪 ID cards**. Choose a class; cards print 8 per A4 page at 85.6 × 54 mm. Laminate and attach to a lanyard or school bag.

If a poster leaks or is damaged, tap **Make a new QR** and print again; the old poster stops working at once. For a lost child's card, open the child's page → **New ID card (lost or damaged)**.

## 4. Phone app (Android / iPhone builds)

The scanner uses the phone's camera and, for staff check-in, its location. After `npx cap add android` / `npx cap add ios`, add these permissions.

**Android** — `android/app/src/main/AndroidManifest.xml`, inside `<manifest>`:

```xml
<uses-permission android:name="android.permission.CAMERA" />
<uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />
<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
<uses-feature android:name="android.hardware.camera" android:required="false" />
<uses-feature android:name="android.hardware.location.gps" android:required="false" />
```

**iPhone** — `ios/App/App/Info.plist`, inside the top `<dict>`:

```xml
<key>NSCameraUsageDescription</key>
<string>Scan the attendance QR in the school office and children's ID cards.</string>
<key>NSLocationWhenInUseUsageDescription</key>
<string>Confirm you are at school when you check in or out.</string>
```

Then `npx cap sync`. In the web app (browser or Home Screen install) nothing extra is needed; it must be served over HTTPS, which GitHub Pages already does.

## 5. Parent alerts (optional)

Uses the same Web Push keys as the `notify` function.

1. Deploy the function: `supabase functions deploy notify-attendance --no-verify-jwt`
2. Supabase → **Database → Webhooks → Create a new hook**: table `public.att_events`, event **Insert**, type **Supabase Edge Functions**, function `notify-attendance`, add the HTTP header `x-webhook-secret` with the same value as `WEBHOOK_SECRET`.
3. Optional secret `SCHOOL_TIME_ZONE` (default `Asia/Kolkata`).

Parents see: "Aarav reached school at 9:04 AM" and "Aarav was picked up at 12:35 PM by Mother".

## How it behaves

- First scan of the day is check-in; a later scan is check-out (each later scan moves check-out forward).
- Refused, with a plain message: wrong or old QR, more than the allowed distance from school, weak GPS, before check-in opens.
- Flagged for the admin, but saved: a new phone, check-in after check-in closes.
- Child cards: a repeat scan within 10 minutes is ignored. Without internet, card scans are saved on the phone and sent later with their scan time.
- Staff scans need internet, because location and time are checked on the server.
- The admin can add a missed scan with a reason (**Attendance & QR → Fix a missed scan**); it is logged as manual.

Known limit: fake-GPS apps on Android can fool the location check. If that happens, show the office QR on a tablet that changes the code regularly (a later upgrade; the server check stays the same).
