-- =====================================================================
-- Aarambh Pre School — database schema
-- PostgreSQL 15+ on Supabase (open source; hosted or self-hosted)
--
-- Design: each app "collection" is one table holding a JSONB document,
-- plus GENERATED columns for the fields that security and filtering use
-- (class, audience, author, dates). Row Level Security (RLS) decides who
-- can read or change each row; an UPDATE trigger limits which fields
-- parents and teachers may change. Run this whole file once in the
-- Supabase SQL editor (or `supabase db push`). Safe to re-run.
-- =====================================================================

create schema if not exists private;
grant usage on schema private to authenticated;

-- ---------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------
create table if not exists public.members (          -- app accounts (parents, staff, admins)
  id          uuid primary key references auth.users(id) on delete cascade,
  data        jsonb not null default '{}'::jsonb,     -- {name, phone, role, status, studentIds[], classes[], ...}
  role        text generated always as (data->>'role') stored,
  status      text generated always as (data->>'status') stored,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists public.students (         -- child profile, parents' details, fees[], photo
  id text primary key, data jsonb not null default '{}'::jsonb,
  cls text generated always as (data->>'cls') stored,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table if not exists public.att_students (     -- one row per date + class: {date, cls, marks{studentId: P|A|L}}
  id text primary key, data jsonb not null default '{}'::jsonb,
  cls text generated always as (data->>'cls') stored,
  att_date text generated always as (data->>'date') stored,   -- ISO yyyy-mm-dd
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table if not exists public.att_staff (        -- one row per date: {date, marks{memberId: {k, at}}}
  id text primary key, data jsonb not null default '{}'::jsonb,
  att_date text generated always as (data->>'date') stored,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table if not exists public.meals     (id text primary key, data jsonb not null default '{}'::jsonb, created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create table if not exists public.plans     (id text primary key, data jsonb not null default '{}'::jsonb, created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create table if not exists public.datesheet (id text primary key, data jsonb not null default '{}'::jsonb, created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create table if not exists public.holidays  (id text primary key, data jsonb not null default '{}'::jsonb, created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create table if not exists public.toppers   (id text primary key, data jsonb not null default '{}'::jsonb, created_at timestamptz not null default now(), updated_at timestamptz not null default now());

create table if not exists public.notices (
  id text primary key, data jsonb not null default '{}'::jsonb,
  audience   text generated always as (data->>'audience') stored,   -- all | parents | staff
  created_by text generated always as (data->>'by') stored,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table if not exists public.tickets (          -- helpdesk
  id text primary key, data jsonb not null default '{}'::jsonb,
  created_by text generated always as (data->>'by') stored,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table if not exists public.gallery (          -- feed posts: {path, kind, caption, cls, parents, likes{}, by, createdAt}
  id text primary key, data jsonb not null default '{}'::jsonb,
  cls        text    generated always as (data->>'cls') stored,
  parents    boolean generated always as ((data->>'parents')::boolean) stored,
  created_by text    generated always as (data->>'by') stored,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table if not exists public.stories (          -- 24-hour stories
  id text primary key, data jsonb not null default '{}'::jsonb,
  cls        text    generated always as (data->>'cls') stored,
  parents    boolean generated always as ((data->>'parents')::boolean) stored,
  created_by text    generated always as (data->>'by') stored,
  created_ms bigint  generated always as ((data->>'createdAt')::bigint) stored,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table if not exists public.push_subscriptions (   -- Web Push endpoints, one per device
  endpoint   text primary key,
  uid        uuid not null references auth.users(id) on delete cascade,
  sub        jsonb not null,
  platform   text,
  created_at timestamptz not null default now()
);

create index if not exists att_students_date_idx on public.att_students (att_date);
create index if not exists att_students_cls_idx  on public.att_students (cls);
create index if not exists att_staff_date_idx    on public.att_staff (att_date);
create index if not exists gallery_cls_idx       on public.gallery (cls, parents);
create index if not exists stories_created_idx   on public.stories (created_ms);
create index if not exists notices_audience_idx  on public.notices (audience);
create index if not exists tickets_by_idx        on public.tickets (created_by);
create index if not exists push_uid_idx          on public.push_subscriptions (uid);

-- ---------------------------------------------------------------------
-- Helper functions (private schema; not exposed through the REST API)
-- ---------------------------------------------------------------------
create or replace function private.me() returns jsonb
language sql stable security definer set search_path = '' as $$
  select m.data from public.members m where m.id = auth.uid()
$$;

create or replace function private.is_approved() returns boolean
language sql stable set search_path = '' as $$
  select coalesce(private.me()->>'status' = 'approved', false)
$$;

create or replace function private.app_role() returns text
language sql stable set search_path = '' as $$
  select case when private.is_approved() then private.me()->>'role' end
$$;

create or replace function private.is_staff()  returns boolean language sql stable set search_path = '' as $$ select coalesce(private.app_role() in ('admin','staff'), false) $$;
create or replace function private.is_admin()  returns boolean language sql stable set search_path = '' as $$ select coalesce(private.app_role() = 'admin', false) $$;
create or replace function private.is_parent() returns boolean language sql stable set search_path = '' as $$ select coalesce(private.app_role() = 'parent', false) $$;

create or replace function private.my_classes() returns text[]
language sql stable set search_path = '' as $$
  select coalesce(array(select jsonb_array_elements_text(coalesce(private.me()->'classes', '[]'::jsonb))), '{}')
$$;

create or replace function private.my_kids() returns text[]
language sql stable set search_path = '' as $$
  select coalesce(array(select jsonb_array_elements_text(coalesce(private.me()->'studentIds', '[]'::jsonb))), '{}')
$$;

-- keys whose values differ between two JSON objects
create or replace function private.changed_keys(o jsonb, n jsonb) returns text[]
language sql immutable set search_path = '' as $$
  select coalesce(array_agg(s.k), '{}')
  from (select jsonb_object_keys(coalesce(o, '{}'::jsonb)) as k
        union select jsonb_object_keys(coalesce(n, '{}'::jsonb))) s
  where (coalesce(o, '{}'::jsonb) -> s.k) is distinct from (coalesce(n, '{}'::jsonb) -> s.k)
$$;

-- recursive merge used for partial updates (e.g. one like, one attendance mark)
create or replace function private.jsonb_deep_merge(a jsonb, b jsonb) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare k text; r jsonb;
begin
  if a is null or jsonb_typeof(a) <> 'object' or b is null or jsonb_typeof(b) <> 'object' then
    return b;
  end if;
  r := a;
  for k in select jsonb_object_keys(b) loop
    if r ? k and jsonb_typeof(r->k) = 'object' and jsonb_typeof(b->k) = 'object' then
      r := jsonb_set(r, array[k], private.jsonb_deep_merge(r->k, b->k));
    else
      r := r || jsonb_build_object(k, b->k);
    end if;
  end loop;
  return r;
end $$;

grant execute on all functions in schema private to authenticated;

-- ---------------------------------------------------------------------
-- Triggers: updated_at + field-level limits for non-admins
-- ---------------------------------------------------------------------
create or replace function private.touch() returns trigger
language plpgsql set search_path = '' as $$
begin new.updated_at := now(); return new; end $$;

create or replace function private.guard_update() returns trigger
language plpgsql security definer set search_path = '' as $$
declare ck text[];
begin
  -- SQL editor / service role (no signed-in user) and admins may change anything
  if auth.uid() is null or private.is_admin() then return new; end if;
  if new.id is distinct from old.id then raise exception 'Row id cannot change' using errcode = '42501'; end if;
  ck := private.changed_keys(old.data, new.data);

  if tg_table_name = 'members' then
    if new.id = auth.uid() and ck <@ array['name','phone'] then return new; end if;

  elsif tg_table_name = 'students' then
    if private.is_staff() and ck <@ array['photo'] then return new; end if;
    if private.is_parent() and new.id = any(private.my_kids())
       and ck <@ array['fatherName','fatherPhone','fatherJob','motherName','motherPhone','motherJob',
                       'email','address','emergency','photo'] then return new; end if;

  elsif tg_table_name = 'gallery' then
    if private.is_staff() then return new; end if;
    -- parents may only add or remove their own like
    if ck <@ array['likes'] and private.changed_keys(coalesce(old.data->'likes','{}'::jsonb),
                                                     coalesce(new.data->'likes','{}'::jsonb)) <@ array[auth.uid()::text] then
      return new;
    end if;

  elsif tg_table_name = 'tickets' then
    if old.data->>'by' = auth.uid()::text and ck <@ array['replies','updatedAt','status'] then return new; end if;

  else
    if private.is_staff() then return new; end if;   -- RLS already limits these tables to staff
  end if;

  raise exception 'Not allowed to change: %', array_to_string(ck, ', ') using errcode = '42501';
end $$;

do $$
declare t text;
begin
  foreach t in array array['members','students','att_students','att_staff','meals','plans','datesheet',
                           'holidays','toppers','notices','tickets','gallery','stories'] loop
    execute format('drop trigger if exists touch on public.%I', t);
    execute format('create trigger touch before update on public.%I for each row execute function private.touch()', t);
    execute format('drop trigger if exists guard on public.%I', t);
    execute format('create trigger guard before update on public.%I for each row execute function private.guard_update()', t);
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;
alter table public.push_subscriptions enable row level security;

-- ---------------------------------------------------------------------
-- Row Level Security policies
-- (select private.fn()) lets Postgres evaluate each helper once per query.
-- ---------------------------------------------------------------------
-- members
drop policy if exists members_read   on public.members;
drop policy if exists members_insert on public.members;
drop policy if exists members_update on public.members;
drop policy if exists members_delete on public.members;
-- staff see everyone; parents see themselves plus staff (names on posts and replies),
-- never other parents' details
create policy members_read on public.members for select to authenticated
  using (id = (select auth.uid())
      or (select private.is_staff())
      or ((select private.is_approved()) and role in ('admin','staff') and status = 'approved'));
create policy members_insert on public.members for insert to authenticated
  with check (id = (select auth.uid())
              and data->>'status' = 'pending'
              and data->>'role' in ('parent','staff')
              and coalesce(jsonb_array_length(data->'studentIds'), 0) = 0
              and not (data ? 'classes'));
create policy members_update on public.members for update to authenticated
  using ((select private.is_admin()) or id = (select auth.uid()));
create policy members_delete on public.members for delete to authenticated
  using ((select private.is_admin()));

-- students
drop policy if exists students_read   on public.students;
drop policy if exists students_write  on public.students;
drop policy if exists students_update on public.students;
drop policy if exists students_delete on public.students;
create policy students_read on public.students for select to authenticated
  using ((select private.is_staff()) or ((select private.is_parent()) and id = any((select private.my_kids()))));
create policy students_write on public.students for insert to authenticated
  with check ((select private.is_admin()));
create policy students_update on public.students for update to authenticated
  using ((select private.is_staff()) or ((select private.is_parent()) and id = any((select private.my_kids()))));
create policy students_delete on public.students for delete to authenticated
  using ((select private.is_admin()));

-- student attendance
drop policy if exists att_students_read  on public.att_students;
drop policy if exists att_students_write on public.att_students;
create policy att_students_read on public.att_students for select to authenticated
  using ((select private.is_staff()) or ((select private.is_parent()) and cls = any((select private.my_classes()))));
create policy att_students_write on public.att_students for all to authenticated
  using ((select private.is_staff())) with check ((select private.is_staff()));

-- staff attendance
drop policy if exists att_staff_all on public.att_staff;
create policy att_staff_all on public.att_staff for all to authenticated
  using ((select private.is_staff())) with check ((select private.is_staff()));

-- everyone approved reads; staff write
do $$
declare t text;
begin
  foreach t in array array['meals','plans','datesheet','toppers'] loop
    execute format('drop policy if exists %s on public.%I', t || '_read', t);
    execute format('drop policy if exists %s on public.%I', t || '_write', t);
    execute format('create policy %s on public.%I for select to authenticated using ((select private.is_approved()))', t || '_read', t);
    execute format('create policy %s on public.%I for all to authenticated using ((select private.is_staff())) with check ((select private.is_staff()))', t || '_write', t);
  end loop;
end $$;

-- holidays: admin writes
drop policy if exists holidays_read  on public.holidays;
drop policy if exists holidays_write on public.holidays;
create policy holidays_read on public.holidays for select to authenticated using ((select private.is_approved()));
create policy holidays_write on public.holidays for all to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));

-- notices
drop policy if exists notices_read   on public.notices;
drop policy if exists notices_insert on public.notices;
drop policy if exists notices_change on public.notices;
drop policy if exists notices_delete on public.notices;
create policy notices_read on public.notices for select to authenticated
  using ((select private.is_staff()) or ((select private.is_parent()) and audience in ('all','parents')));
create policy notices_insert on public.notices for insert to authenticated
  with check ((select private.is_staff()) and created_by = (select auth.uid())::text);
create policy notices_change on public.notices for update to authenticated
  using ((select private.is_admin()) or ((select private.is_staff()) and created_by = (select auth.uid())::text));
create policy notices_delete on public.notices for delete to authenticated
  using ((select private.is_admin()) or ((select private.is_staff()) and created_by = (select auth.uid())::text));

-- helpdesk tickets
drop policy if exists tickets_read   on public.tickets;
drop policy if exists tickets_insert on public.tickets;
drop policy if exists tickets_update on public.tickets;
drop policy if exists tickets_delete on public.tickets;
create policy tickets_read on public.tickets for select to authenticated
  using ((select private.is_admin()) or ((select private.is_approved()) and created_by = (select auth.uid())::text));
create policy tickets_insert on public.tickets for insert to authenticated
  with check ((select private.is_approved()) and created_by = (select auth.uid())::text);
create policy tickets_update on public.tickets for update to authenticated
  using ((select private.is_admin()) or created_by = (select auth.uid())::text);
create policy tickets_delete on public.tickets for delete to authenticated
  using ((select private.is_admin()));

-- gallery (feed) and stories: parents see only posts shared with parents,
-- for their own child's class or the whole school
drop policy if exists gallery_read   on public.gallery;
drop policy if exists gallery_insert on public.gallery;
drop policy if exists gallery_update on public.gallery;
drop policy if exists gallery_delete on public.gallery;
create policy gallery_read on public.gallery for select to authenticated
  using ((select private.is_staff())
      or ((select private.is_parent()) and parents and (cls = 'all' or cls = any((select private.my_classes())))));
create policy gallery_insert on public.gallery for insert to authenticated
  with check ((select private.is_staff()) and created_by = (select auth.uid())::text);
create policy gallery_update on public.gallery for update to authenticated   -- parents: likes only (see trigger)
  using ((select private.is_staff())
      or ((select private.is_parent()) and parents and (cls = 'all' or cls = any((select private.my_classes())))));
create policy gallery_delete on public.gallery for delete to authenticated
  using ((select private.is_staff()));

drop policy if exists stories_read  on public.stories;
drop policy if exists stories_write on public.stories;
create policy stories_read on public.stories for select to authenticated
  using ((select private.is_staff())
      or ((select private.is_parent()) and parents and (cls = 'all' or cls = any((select private.my_classes())))));
create policy stories_write on public.stories for all to authenticated
  using ((select private.is_staff())) with check ((select private.is_staff()));

-- push subscriptions: each person manages their own devices
drop policy if exists push_own on public.push_subscriptions;
create policy push_own on public.push_subscriptions for all to authenticated
  using (uid = (select auth.uid())) with check (uid = (select auth.uid()));

-- ---------------------------------------------------------------------
-- Partial update RPC used by the app (atomic deep merge; RLS still applies)
-- ---------------------------------------------------------------------
create or replace function public.patch_doc(p_table text, p_id text, p_part jsonb) returns void
language plpgsql security invoker set search_path = '' as $$
declare n int;
begin
  if p_table not in ('members','students','att_students','att_staff','meals','plans','datesheet',
                     'holidays','toppers','notices','tickets','gallery','stories') then
    raise exception 'Unknown table %', p_table using errcode = '22023';
  end if;
  execute format('update public.%I set data = private.jsonb_deep_merge(data, $2) where id::text = $1', p_table)
    using p_id, p_part;
  get diagnostics n = row_count;
  if n = 0 then
    if p_table = 'members' then raise exception 'Account not found' using errcode = '42501'; end if;
    execute format('insert into public.%I (id, data) values ($1, $2)', p_table) using p_id, p_part;
  end if;
end $$;
revoke execute on function public.patch_doc(text, text, jsonb) from public, anon;
grant  execute on function public.patch_doc(text, text, jsonb) to authenticated;

-- ---------------------------------------------------------------------
-- Realtime (live updates in the app)
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['members','students','att_students','att_staff','meals','plans','datesheet',
                           'holidays','toppers','notices','tickets','gallery','stories'] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception
      when duplicate_object then null;
      when undefined_object then raise notice 'supabase_realtime publication not found; live updates off';
    end;
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- File storage: private bucket, files under <user id>/...
-- The app shows files through signed links that expire after a day.
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('media', 'media', false, 52428800, array['image/*','video/*'])
on conflict (id) do nothing;

drop policy if exists media_read   on storage.objects;
drop policy if exists media_upload on storage.objects;
drop policy if exists media_delete on storage.objects;
create policy media_read on storage.objects for select to authenticated
  using (bucket_id = 'media' and (select private.is_approved()));
create policy media_upload on storage.objects for insert to authenticated
  with check (bucket_id = 'media' and (select private.is_approved())
              and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy media_delete on storage.objects for delete to authenticated
  using (bucket_id = 'media' and ((storage.foldername(name))[1] = (select auth.uid())::text or (select private.is_staff())));
