begin;

create schema if not exists antrakt_private;
revoke all on schema antrakt_private from public, anon, authenticated;

create table if not exists antrakt_private.calendars (
  id uuid primary key,
  edit_hash bytea not null,
  view_hash bytea not null,
  revision integer not null default 0,
  data jsonb not null default '{"events":[],"hiddenShows":[],"importantShows":[]}'::jsonb
);
alter table antrakt_private.calendars enable row level security;
revoke all on antrakt_private.calendars from public, anon, authenticated;

create or replace function public.antrakt_read(calendar_id uuid, access_token text)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'revision', c.revision, 'data', c.data,
    'canEdit', c.edit_hash = pg_catalog.sha256(pg_catalog.convert_to(access_token, 'UTF8'))
  )
  from antrakt_private.calendars c
  where c.id = calendar_id and access_token ~ '^[a-f0-9]{64}$'
    and pg_catalog.sha256(pg_catalog.convert_to(access_token, 'UTF8')) in (c.edit_hash, c.view_hash);
$$;

create or replace function public.antrakt_write(calendar_id uuid, access_token text, expected_revision integer, next_data jsonb)
returns integer
language sql volatile security definer set search_path = ''
as $$
  update antrakt_private.calendars as c
  set data = next_data, revision = c.revision + 1
  where c.id = calendar_id and c.revision = expected_revision
    and access_token ~ '^[a-f0-9]{64}$'
    and c.edit_hash = pg_catalog.sha256(pg_catalog.convert_to(access_token, 'UTF8'))
    and pg_catalog.pg_column_size(next_data) <= 1000000
    and pg_catalog.jsonb_typeof(next_data -> 'events') = 'array'
    and pg_catalog.jsonb_typeof(next_data -> 'hiddenShows') = 'array'
    and pg_catalog.jsonb_typeof(next_data -> 'importantShows') = 'array'
  returning c.revision;
$$;

revoke all on function public.antrakt_read(uuid, text) from public;
revoke all on function public.antrakt_write(uuid, text, integer, jsonb) from public;
grant execute on function public.antrakt_read(uuid, text) to anon, authenticated;
grant execute on function public.antrakt_write(uuid, text, integer, jsonb) to anon, authenticated;

commit;

-- Run this block once for each new shared calendar. Save both links privately.
with keys as materialized (
  select gen_random_uuid() as id,
         replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '') as edit_token,
         replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '') as view_token
), created as (
  insert into antrakt_private.calendars (id, edit_hash, view_hash)
  select id, sha256(convert_to(edit_token, 'UTF8')), sha256(convert_to(view_token, 'UTF8')) from keys
  returning id
)
select 'https://arishkawolf.github.io/planer/#sync=' || id || '.' || edit_token as edit_link,
       'https://arishkawolf.github.io/planer/#sync=' || id || '.' || view_token as view_link
from keys join created using (id);
