-- =====================================================================
-- Aarambh Pre School — parent-reported student leave
--
-- A parent reports that their child will be on leave (from home, in the
-- app). The request is saved by a server function that checks the parent
-- really is linked to that child, the dates and the reason, then teachers
-- and the admin are told straight away (in-app live update + phone alert
-- from the notify-leave Edge Function).
--
-- Run once in the Supabase SQL editor after 20261121000000_qr_attendance.sql
-- (or `supabase db push`). Safe to re-run.
-- =====================================================================

create table if not exists public.leave_requests (
  id          text primary key,
  data        jsonb not null default '{}'::jsonb,   -- {studentId, studentName, cls, from, to, reason, status, by, byName, createdAt}
  student_id  text generated always as (data->>'studentId') stored,
  cls         text generated always as (data->>'cls') stored,
  from_date   text generated always as (data->>'from') stored,      -- ISO yyyy-mm-dd (compares correctly as text)
  to_date     text generated always as (data->>'to') stored,
  status      text generated always as (data->>'status') stored,    -- active | cancelled
  created_by  text generated always as (data->>'by') stored,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists leave_student_idx on public.leave_requests (student_id, from_date, to_date);
create index if not exists leave_dates_idx   on public.leave_requests (to_date);
create index if not exists leave_by_idx      on public.leave_requests (created_by, created_at);

alter table public.leave_requests enable row level security;

-- Read only. There is deliberately no insert/update policy: parents write
-- through apply_leave() / cancel_leave() below, which run every check on the server.
drop policy if exists leave_read   on public.leave_requests;
drop policy if exists leave_delete on public.leave_requests;
create policy leave_read on public.leave_requests for select to authenticated
  using ((select private.is_staff())
      or ((select private.is_parent()) and student_id = any(((select private.my_kids())::text[]))));
create policy leave_delete on public.leave_requests for delete to authenticated
  using ((select private.is_admin()));

drop trigger if exists touch on public.leave_requests;
create trigger touch before update on public.leave_requests for each row execute function private.touch();

-- ---------------------------------------------------------------------
-- Parent: report a leave
-- ---------------------------------------------------------------------
create or replace function public.apply_leave(p_student text, p_from date, p_to date, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid    uuid := auth.uid();
  v_tz     text := coalesce((select a.tz from public.att_sites a where a.id = 'office'), 'Asia/Kolkata');
  v_today  date := (now() at time zone v_tz)::date;
  v_reason text := left(btrim(coalesce(p_reason, '')), 200);
  v_from   text; v_to text;
  st       public.students;
  v_id     text := replace(gen_random_uuid()::text, '-', '');
  v_doc    jsonb;
begin
  if v_uid is null or not private.is_parent() then
    raise exception 'Only a parent can report a leave.' using errcode = '42501';
  end if;
  if p_student is null or not (p_student = any(private.my_kids())) then
    raise exception 'You can report leave only for your own child.' using errcode = '42501';
  end if;
  select * into st from public.students x where x.id = p_student;
  if not found then raise exception 'Child not found. Contact the school office.'; end if;

  if p_from is null or p_to is null then raise exception 'Choose the leave dates.'; end if;
  if p_from < v_today then raise exception 'Leave can start today or later. For earlier days, ask the school office.'; end if;
  if p_to < p_from then raise exception '"To" date must be on or after the "From" date.'; end if;
  if p_to - p_from > 30 then raise exception 'You can report up to 31 days at a time. For a longer leave, contact the school office.'; end if;
  if v_reason = '' then raise exception 'Write a short reason for the leave.'; end if;

  v_from := to_char(p_from, 'YYYY-MM-DD'); v_to := to_char(p_to, 'YYYY-MM-DD');

  if exists (select 1 from public.leave_requests l
              where l.student_id = p_student and l.status = 'active' and l.from_date <= v_to and l.to_date >= v_from) then
    raise exception 'Leave is already reported for some of these dates. Cancel it first to change it.';
  end if;
  if (select count(*) from public.leave_requests l
       where l.created_by = v_uid::text and l.created_at > now() - interval '1 day') >= 10 then
    raise exception 'Too many leave requests today. Please call the school office.';
  end if;

  v_doc := jsonb_build_object(
    'studentId', st.id, 'studentName', coalesce(st.data->>'name', 'Student'), 'cls', st.cls,
    'from', v_from, 'to', v_to, 'reason', v_reason, 'status', 'active',
    'by', v_uid::text, 'byName', coalesce(private.me()->>'name', 'Parent'), 'createdAt', private.ms(now()));
  insert into public.leave_requests (id, data) values (v_id, v_doc);
  return jsonb_build_object('id', v_id) || v_doc;
end $$;

-- ---------------------------------------------------------------------
-- Parent (who reported it) or admin: cancel a leave that has not ended
-- ---------------------------------------------------------------------
create or replace function public.cancel_leave(p_id text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid   uuid := auth.uid();
  v_tz    text := coalesce((select a.tz from public.att_sites a where a.id = 'office'), 'Asia/Kolkata');
  v_today text := to_char((now() at time zone v_tz)::date, 'YYYY-MM-DD');
  l       public.leave_requests;
begin
  if v_uid is null then raise exception 'Not signed in.' using errcode = '42501'; end if;
  select * into l from public.leave_requests x where x.id = p_id for update;
  if not found then raise exception 'Leave request not found.'; end if;
  if not (private.is_admin() or (private.is_parent() and l.created_by = v_uid::text)) then
    raise exception 'Only the parent who reported this leave can cancel it.' using errcode = '42501';
  end if;
  if l.status <> 'active' then return; end if;                       -- already cancelled
  if l.to_date < v_today then raise exception 'This leave has already ended.'; end if;
  update public.leave_requests x
     set data = x.data || jsonb_build_object('status', 'cancelled', 'cancelledAt', private.ms(now()), 'cancelledBy', v_uid::text)
   where x.id = p_id;
end $$;

do $$
declare f text;
begin
  foreach f in array array['apply_leave(text, date, date, text)', 'cancel_leave(text)'] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

-- live updates: staff screens refresh the moment a leave is reported
do $$
begin
  alter publication supabase_realtime add table public.leave_requests;
exception
  when duplicate_object then null;
  when undefined_object then raise notice 'supabase_realtime publication not found; live updates off';
end $$;
