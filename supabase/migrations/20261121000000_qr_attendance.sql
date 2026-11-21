-- =====================================================================
-- Aarambh Pre School — QR attendance (check-in / check-out)
--
-- Staff scan the office wall QR to check in and out; teachers scan
-- children's ID cards at arrival and pickup. Every scan goes through a
-- server function that checks it, takes the time from the database clock
-- (India time), writes an append-only log (att_events) and updates the
-- existing att_staff / att_students rows so the current screens keep working.
--
-- Run once in the Supabase SQL editor after 20260929000000_init.sql
-- (or `supabase db push`). Safe to re-run.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------
create table if not exists public.att_sites (          -- scan points; the app uses one: 'office'
  id             text primary key,
  name           text not null default 'School office',
  lat            double precision,                       -- set by the admin from "Use my current location"
  lng            double precision,
  radius_m       int  not null default 150 check (radius_m between 20 and 2000),
  max_accuracy_m int  not null default 100 check (max_accuracy_m between 10 and 1000),
  qr_code        text not null default upper(replace(gen_random_uuid()::text, '-', '')),   -- the secret on the poster
  tz             text not null default 'Asia/Kolkata',
  open_time      time not null default '09:00',
  late_after     time not null default '09:15',
  checkin_from   time not null default '06:00',
  checkin_until  time not null default '12:00',
  min_gap_min    int  not null default 30 check (min_gap_min between 0 and 600),   -- check-in to check-out
  active         boolean not null default true,
  updated_at     timestamptz not null default now()
);
insert into public.att_sites (id) values ('office') on conflict (id) do nothing;

create table if not exists public.id_cards (           -- one active card per child; lost cards are revoked
  token       text primary key,                        -- 16 hex characters, printed in the QR as AARAMBH:STU:<token>
  student_id  text not null references public.students(id) on delete cascade,
  issued_at   timestamptz not null default now(),
  issued_by   uuid,
  revoked_at  timestamptz
);
create unique index if not exists id_cards_one_active on public.id_cards (student_id) where revoked_at is null;

create table if not exists public.att_events (         -- append-only log of every scan and correction
  id            bigint generated always as identity primary key,
  kind          text not null check (kind in ('staff', 'student')),
  subject_id    text not null,                         -- members.id (staff) or students.id
  direction     text not null check (direction in ('in', 'out')),
  at            timestamptz not null default now(),
  att_date      date not null,                         -- school-local date
  cls           text,                                  -- students only
  method        text not null default 'qr' check (method in ('qr', 'manual')),
  by_uid        uuid,
  distance_m    int,                                   -- staff scans: distance from school; raw GPS is not kept
  accuracy_m    int,
  device_id     text,
  picked_up_by  text,                                  -- students, direction 'out'
  flags         text[] not null default '{}',
  note          text
);
create index if not exists att_events_subject_idx on public.att_events (kind, subject_id, att_date);
create index if not exists att_events_date_idx    on public.att_events (att_date);

create table if not exists public.staff_devices (      -- the phone each staff member checks in from
  uid         uuid not null references auth.users(id) on delete cascade,
  device_id   text not null,
  first_seen  timestamptz not null default now(),
  approved    boolean not null default false,
  primary key (uid, device_id)
);

alter table public.att_sites     enable row level security;
alter table public.id_cards      enable row level security;
alter table public.att_events    enable row level security;
alter table public.staff_devices enable row level security;

-- Admins manage settings, cards and phones directly. Nobody writes att_events
-- directly: only the functions below (security definer) insert into it.
drop policy if exists att_sites_admin     on public.att_sites;
drop policy if exists id_cards_admin      on public.id_cards;
drop policy if exists staff_devices_admin on public.staff_devices;
drop policy if exists att_events_read     on public.att_events;
create policy att_sites_admin on public.att_sites for all to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));
create policy id_cards_admin on public.id_cards for all to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));
create policy staff_devices_admin on public.staff_devices for all to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));
create policy att_events_read on public.att_events for select to authenticated
  using ((select private.is_staff())
      or ((select private.is_parent()) and kind = 'student' and subject_id = any(private.my_kids())));

drop trigger if exists touch on public.att_sites;
create trigger touch before update on public.att_sites for each row execute function private.touch();

-- ---------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------
create or replace function private.distance_m(lat1 double precision, lng1 double precision,
                                              lat2 double precision, lng2 double precision) returns int
language sql immutable set search_path = '' as $$
  select round(2 * 6371000 * asin(sqrt(
           power(sin(radians(lat2 - lat1) / 2), 2) +
           cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lng2 - lng1) / 2), 2))))::int
$$;

create or replace function private.ms(t timestamptz) returns bigint
language sql immutable set search_path = '' as $$ select (extract(epoch from t) * 1000)::bigint $$;

create or replace function private.clock(t timestamptz, tz text) returns text
language sql stable set search_path = '' as $$ select ltrim(to_char(t at time zone tz, 'HH12:MI AM'), '0') $$;

-- "AARAMBH:STU:1a2b-3c4d…" or a typed "1A2B 3C4D…" → "1A2B3C4D…"
create or replace function private.card_token(p text) returns text
language sql immutable set search_path = '' as $$
  select upper(regexp_replace(regexp_replace(coalesce(p, ''), '^\s*AARAMBH:STU:', '', 'i'), '[^0-9A-Za-z]', '', 'g'))
$$;

create or replace function private.new_card_token() returns text
language sql volatile set search_path = '' as $$ select upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 16)) $$;

-- writes one staff mark into att_staff (row id = date), keeping other people's marks
create or replace function private.put_staff_mark(p_date date, p_uid uuid, p_mark jsonb) returns void
language sql security definer set search_path = '' as $$
  insert into public.att_staff (id, data)
  values (p_date::text, jsonb_build_object('date', p_date::text, 'marks', jsonb_build_object(p_uid::text, p_mark)))
  on conflict (id) do update
    set data = private.jsonb_deep_merge(
                 jsonb_set(public.att_staff.data, array['marks', p_uid::text],
                           case when jsonb_typeof(public.att_staff.data #> array['marks', p_uid::text]) = 'object'
                                then public.att_staff.data #> array['marks', p_uid::text] else '{}'::jsonb end,
                           true),
                 excluded.data)
$$;

-- writes one child's mark + times into att_students (row id = date_class)
create or replace function private.put_student_mark(p_date date, p_cls text, p_sid text, p_times jsonb) returns void
language sql security definer set search_path = '' as $$
  insert into public.att_students (id, data)
  values (p_date::text || '_' || p_cls,
          jsonb_build_object('date', p_date::text, 'cls', p_cls,
                             'marks', jsonb_build_object(p_sid, 'P'),
                             'times', jsonb_build_object(p_sid, p_times)))
  on conflict (id) do update
    set data = private.jsonb_deep_merge(public.att_students.data, excluded.data)
$$;

-- ---------------------------------------------------------------------
-- Staff: scan the office QR
-- ---------------------------------------------------------------------
create or replace function public.scan_staff(p_code text, p_lat double precision, p_lng double precision,
                                             p_accuracy double precision, p_device text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid   uuid := auth.uid();
  s       public.att_sites;
  v_now   timestamptz := now();
  v_local timestamp; v_date date; v_time time;
  v_dist  int; v_acc int;
  v_flags text[] := '{}';
  v_in    public.att_events; v_last public.att_events;
  v_dir   text; v_late boolean := false;
  v_mark  jsonb;
begin
  if v_uid is null or not private.is_staff() then
    raise exception 'Only approved school staff can mark attendance.' using errcode = '42501';
  end if;

  select * into s from public.att_sites a
   where a.active and 'AARAMBH:SITE:' || a.id || ':' || a.qr_code = btrim(coalesce(p_code, ''));
  if not found then
    raise exception 'This is not the current Aarambh attendance QR. Ask the admin for the latest poster.';
  end if;
  if s.lat is null or s.lng is null then
    raise exception 'The admin has not saved the school location yet (Admin → Attendance & QR).';
  end if;

  if p_lat is null or p_lng is null then
    raise exception 'Turn on location for the Aarambh app, then scan again.';
  end if;
  v_acc := round(coalesce(p_accuracy, 9999))::int;
  if v_acc > s.max_accuracy_m then
    raise exception 'Your location is not exact enough yet (about % m). Wait a few seconds near a window and scan again.', v_acc;
  end if;
  v_dist := private.distance_m(s.lat, s.lng, p_lat, p_lng);
  if v_dist > s.radius_m then
    raise exception 'You seem to be % from school. Scan the QR when you reach the office.',
      case when v_dist >= 1000 then to_char(v_dist / 1000.0, 'FM9990.0') || ' km' else v_dist || ' m' end;
  end if;

  -- the phone: first phone is trusted; a different phone is saved and flagged for the admin
  if coalesce(btrim(p_device), '') = '' then
    v_flags := array_append(v_flags, 'no_device');
  elsif not exists (select 1 from public.staff_devices d where d.uid = v_uid) then
    insert into public.staff_devices (uid, device_id, approved) values (v_uid, p_device, true);
  elsif not exists (select 1 from public.staff_devices d where d.uid = v_uid and d.device_id = p_device and d.approved) then
    insert into public.staff_devices (uid, device_id, approved) values (v_uid, p_device, false) on conflict do nothing;
    v_flags := array_append(v_flags, 'new_device');
  end if;

  v_local := v_now at time zone s.tz; v_date := v_local::date; v_time := v_local::time;

  select * into v_in from public.att_events e
   where e.kind = 'staff' and e.subject_id = v_uid::text and e.att_date = v_date and e.direction = 'in'
   order by e.at limit 1;

  if not found then
    if v_time < s.checkin_from then
      raise exception 'Check-in opens at %.', ltrim(to_char(s.checkin_from, 'HH12:MI AM'), '0');
    end if;
    v_dir := 'in';
    v_late := v_time > s.late_after;
    if v_time > s.checkin_until then v_flags := array_append(v_flags, 'late_checkin'); end if;
  else
    if v_now - v_in.at < make_interval(mins => s.min_gap_min) then
      return jsonb_build_object('direction', 'in', 'at', private.ms(v_in.at), 'already', true,
                                'message', 'Already checked in at ' || private.clock(v_in.at, s.tz) || '.');
    end if;
    select * into v_last from public.att_events e
     where e.kind = 'staff' and e.subject_id = v_uid::text and e.att_date = v_date and e.direction = 'out'
     order by e.at desc limit 1;
    if found and v_now - v_last.at < interval '2 minutes' then
      return jsonb_build_object('direction', 'out', 'at', private.ms(v_last.at), 'already', true, 'in_at', private.ms(v_in.at),
                                'message', 'Already checked out at ' || private.clock(v_last.at, s.tz) || '.');
    end if;
    v_dir := 'out';
  end if;

  insert into public.att_events (kind, subject_id, direction, at, att_date, method, by_uid, distance_m, accuracy_m, device_id, flags)
  values ('staff', v_uid::text, v_dir, v_now, v_date, 'qr', v_uid, v_dist, v_acc, nullif(btrim(p_device), ''), v_flags);

  if v_dir = 'in' then
    v_mark := jsonb_build_object('k', 'P', 'at', private.ms(v_now), 'late', v_late, 'via', 'qr');
  else
    v_mark := jsonb_build_object('k', 'P', 'out', private.ms(v_now));
  end if;
  if array_length(v_flags, 1) > 0 then v_mark := v_mark || jsonb_build_object('flags', to_jsonb(v_flags)); end if;
  perform private.put_staff_mark(v_date, v_uid, v_mark);

  return jsonb_build_object('direction', v_dir, 'at', private.ms(v_now), 'late', v_late, 'flags', to_jsonb(v_flags),
                            'distance_m', v_dist, 'in_at', case when v_dir = 'out' then private.ms(v_in.at) end,
                            'message', case when v_dir = 'in' then 'Checked in at ' else 'Checked out at ' end
                                       || private.clock(v_now, s.tz) || case when v_late then ' (late)' else '' end || '.');
end $$;

-- ---------------------------------------------------------------------
-- Students: scan an ID card (p_mode 'in' = arrival, 'out' = pickup)
-- p_scanned_at: phone time in ms, only for scans queued while offline
-- ---------------------------------------------------------------------
create or replace function public.scan_student(p_token text, p_mode text, p_picked_up_by text default null,
                                               p_scanned_at bigint default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid   uuid := auth.uid();
  v_tz    text := coalesce((select a.tz from public.att_sites a where a.id = 'office'), 'Asia/Kolkata');
  v_tok   text := private.card_token(p_token);
  c       public.id_cards;
  st      public.students;
  v_at    timestamptz := now();
  v_date  date;
  v_flags text[] := '{}';
  v_name  text;
  v_times jsonb;
begin
  if v_uid is null or not private.is_staff() then
    raise exception 'Only approved school staff can scan ID cards.' using errcode = '42501';
  end if;
  if p_mode not in ('in', 'out') then raise exception 'Choose Arrival or Pickup.'; end if;

  select * into c from public.id_cards k where k.token = v_tok;
  if not found then raise exception 'This card is not recognised. Check the code or mark the child by hand.'; end if;
  if c.revoked_at is not null then
    raise exception 'This card was replaced. Use the child''s new card, or mark them by hand.';
  end if;
  select * into st from public.students x where x.id = c.student_id;
  if not found then raise exception 'This card belongs to a student who was removed.'; end if;
  v_name := coalesce(st.data->>'name', 'Student');

  if p_scanned_at is not null then                      -- queued offline: trust phone time within 12 hours
    v_at := least(now(), greatest(now() - interval '12 hours', to_timestamp(p_scanned_at / 1000.0)));
    v_flags := array_append(v_flags, 'sent_late');
  end if;
  v_date := (v_at at time zone v_tz)::date;

  if exists (select 1 from public.att_events e
              where e.kind = 'student' and e.subject_id = st.id and e.att_date = v_date and e.direction = p_mode
                and abs(extract(epoch from (e.at - v_at))) < 600) then
    return jsonb_build_object('duplicate', true, 'direction', p_mode, 'at', private.ms(v_at),
                              'student', jsonb_build_object('id', st.id, 'name', v_name, 'cls', st.cls, 'photo', st.data->'photo'));
  end if;

  if p_mode = 'out' and not exists (select 1 from public.att_events e
       where e.kind = 'student' and e.subject_id = st.id and e.att_date = v_date and e.direction = 'in') then
    v_flags := array_append(v_flags, 'no_arrival_scan');
  end if;

  insert into public.att_events (kind, subject_id, direction, at, att_date, cls, method, by_uid, picked_up_by, flags)
  values ('student', st.id, p_mode, v_at, v_date, st.cls, 'qr', v_uid, nullif(btrim(p_picked_up_by), ''), v_flags);

  v_times := case when p_mode = 'in' then jsonb_build_object('in', private.ms(v_at))
                  else jsonb_build_object('out', private.ms(v_at), 'by', nullif(btrim(p_picked_up_by), '')) end;
  perform private.put_student_mark(v_date, st.cls, st.id, v_times);

  return jsonb_build_object('direction', p_mode, 'at', private.ms(v_at), 'flags', to_jsonb(v_flags),
                            'student', jsonb_build_object('id', st.id, 'name', v_name, 'cls', st.cls, 'photo', st.data->'photo'));
end $$;

-- ---------------------------------------------------------------------
-- Admin: fix a missed scan (writes a 'manual' event with the reason)
-- ---------------------------------------------------------------------
create or replace function public.admin_correct(p_kind text, p_subject text, p_date date, p_direction text,
                                                p_time time, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_tz  text := coalesce((select a.tz from public.att_sites a where a.id = 'office'), 'Asia/Kolkata');
  v_at  timestamptz := (p_date + p_time) at time zone v_tz;
  v_cls text;
begin
  if not private.is_admin() then raise exception 'Only the admin can correct attendance.' using errcode = '42501'; end if;
  if p_kind not in ('staff', 'student') or p_direction not in ('in', 'out') then raise exception 'Invalid correction.'; end if;
  if coalesce(btrim(p_reason), '') = '' then raise exception 'Write a short reason for the correction.'; end if;
  if v_at > now() + interval '5 minutes' then raise exception 'That time is in the future.'; end if;

  if p_kind = 'student' then
    select x.cls into v_cls from public.students x where x.id = p_subject;
    if v_cls is null then raise exception 'Student not found.'; end if;
  end if;

  insert into public.att_events (kind, subject_id, direction, at, att_date, cls, method, by_uid, note)
  values (p_kind, p_subject, p_direction, v_at, p_date, v_cls, 'manual', auth.uid(), btrim(p_reason));

  if p_kind = 'staff' then
    perform private.put_staff_mark(p_date, p_subject::uuid,
      case when p_direction = 'in' then jsonb_build_object('k', 'P', 'at', private.ms(v_at), 'via', 'manual')
           else jsonb_build_object('k', 'P', 'out', private.ms(v_at)) end);
  else
    perform private.put_student_mark(p_date, v_cls, p_subject,
      case when p_direction = 'in' then jsonb_build_object('in', private.ms(v_at))
           else jsonb_build_object('out', private.ms(v_at)) end);
  end if;
end $$;

-- ---------------------------------------------------------------------
-- Settings, QR codes and ID cards
-- ---------------------------------------------------------------------
-- what any approved member may know about the office scan point (no secret code)
create or replace function public.att_site_info() returns jsonb
language sql stable security definer set search_path = '' as $$
  select case when not private.is_approved() then null else
    (select jsonb_build_object('configured', a.lat is not null and a.lng is not null, 'name', a.name,
                               'open_time', to_char(a.open_time, 'HH24:MI'), 'late_after', to_char(a.late_after, 'HH24:MI'),
                               'checkin_from', to_char(a.checkin_from, 'HH24:MI'), 'tz', a.tz)
       from public.att_sites a where a.id = 'office') end
$$;

create or replace function public.att_regenerate_code(p_site text default 'office') returns text
language plpgsql security definer set search_path = '' as $$
declare v text;
begin
  if not private.is_admin() then raise exception 'Only the admin can change the QR.' using errcode = '42501'; end if;
  update public.att_sites a set qr_code = upper(replace(gen_random_uuid()::text, '-', '')) where a.id = p_site
  returning 'AARAMBH:SITE:' || a.id || ':' || a.qr_code into v;
  return v;
end $$;

-- active cards for every child in a class, issuing cards for children who have none
create or replace function public.id_cards_for_class(p_cls text) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_admin() then raise exception 'Only the admin can print ID cards.' using errcode = '42501'; end if;
  insert into public.id_cards (token, student_id, issued_by)
  select private.new_card_token(), x.id, auth.uid() from public.students x
   where (p_cls = 'all' or x.cls = p_cls)
     and not exists (select 1 from public.id_cards k where k.student_id = x.id and k.revoked_at is null);
  return coalesce((select jsonb_agg(jsonb_build_object('student_id', k.student_id, 'token', k.token) order by x.data->>'name')
                     from public.id_cards k join public.students x on x.id = k.student_id
                    where k.revoked_at is null and (p_cls = 'all' or x.cls = p_cls)), '[]'::jsonb);
end $$;

-- lost or damaged card: old card stops working, a new one is issued
create or replace function public.replace_id_card(p_student text) returns text
language plpgsql security definer set search_path = '' as $$
declare v text := private.new_card_token();
begin
  if not private.is_admin() then raise exception 'Only the admin can replace ID cards.' using errcode = '42501'; end if;
  if not exists (select 1 from public.students x where x.id = p_student) then raise exception 'Student not found.'; end if;
  update public.id_cards k set revoked_at = now() where k.student_id = p_student and k.revoked_at is null;
  insert into public.id_cards (token, student_id, issued_by) values (v, p_student, auth.uid());
  return v;
end $$;

do $$
declare f text;
begin
  foreach f in array array['scan_staff(text, double precision, double precision, double precision, text)',
                           'scan_student(text, text, text, bigint)',
                           'admin_correct(text, text, date, text, time, text)',
                           'att_site_info()', 'att_regenerate_code(text)',
                           'id_cards_for_class(text)', 'replace_id_card(text)'] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
grant execute on all functions in schema private to authenticated;

-- live updates: the app already listens to att_staff and att_students;
-- att_events is also published for the parent-alert webhook / future reports
do $$
begin
  alter publication supabase_realtime add table public.att_events;
exception
  when duplicate_object then null;
  when undefined_object then raise notice 'supabase_realtime publication not found; live updates off';
end $$;
