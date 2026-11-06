create table public.planner_events (
  id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  title text not null check (char_length(trim(title)) between 1 and 250),
  date date not null check (date between '1900-01-01' and '2199-12-31'),
  time time without time zone,
  type text not null check (type in ('filming', 'rehearsal', 'show', 'personal'))
);

create index planner_events_user_id on public.planner_events (user_id, id);
alter table public.planner_events enable row level security;
revoke all on public.planner_events from anon, authenticated;
grant select, insert, update, delete on public.planner_events to authenticated;

create policy "Each user can access only their events"
on public.planner_events
for all
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);
