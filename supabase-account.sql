-- Run once in the SQL Editor of your Supabase project.
-- Login uses a name and a four-digit PIN. The browser stores a random session,
-- never the PIN. Tables are private and are accessed only by the functions below.
begin;

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create schema if not exists antrakt_private;
revoke all on schema antrakt_private from public, anon, authenticated;

create table if not exists antrakt_private.accounts (
  id uuid primary key default gen_random_uuid(),
  username text not null,
  username_key text not null unique,
  pin_hash text not null,
  revision integer not null default 0,
  data jsonb not null default '{"events":[],"hiddenShows":[],"importantShows":[]}'::jsonb
);
create table if not exists antrakt_private.account_sessions (
  token_hash bytea primary key,
  account_id uuid not null references antrakt_private.accounts(id) on delete cascade,
  expires_at timestamptz not null
);
create index if not exists account_session_expiry on antrakt_private.account_sessions(expires_at);
create table if not exists antrakt_private.account_attempts (
  bucket text primary key,
  started_at timestamptz not null default now(),
  attempts integer not null default 0
);
alter table antrakt_private.accounts enable row level security;
alter table antrakt_private.account_sessions enable row level security;
alter table antrakt_private.account_attempts enable row level security;
revoke all on antrakt_private.accounts, antrakt_private.account_sessions, antrakt_private.account_attempts from public, anon, authenticated;

create or replace function antrakt_private.valid_account_data(value jsonb)
returns boolean language plpgsql immutable set search_path = '' as $$
declare e jsonb; ids jsonb; event_date date;
begin
  if not coalesce(
    pg_catalog.jsonb_typeof(value) = 'object'
    and pg_catalog.pg_column_size(value) <= 1000000
    and pg_catalog.jsonb_typeof(value -> 'events') = 'array'
    and pg_catalog.jsonb_typeof(value -> 'hiddenShows') = 'array'
    and pg_catalog.jsonb_typeof(value -> 'importantShows') = 'array', false) then return false; end if;
  if pg_catalog.jsonb_array_length(value -> 'events') > 5000 then return false; end if;
  for e in select x.value from pg_catalog.jsonb_array_elements(value -> 'events') x loop
    if not coalesce(
      pg_catalog.jsonb_typeof(e) = 'object'
      and pg_catalog.jsonb_typeof(e -> 'id') = 'string'
      and pg_catalog.length(e ->> 'id') between 1 and 200
      and pg_catalog.jsonb_typeof(e -> 'title') = 'string'
      and pg_catalog.length(pg_catalog.btrim(e ->> 'title')) between 1 and 250
      and (e ->> 'date') ~ '^(19|20|21)[0-9]{2}-[0-9]{2}-[0-9]{2}$'
      and pg_catalog.jsonb_typeof(e -> 'time') = 'string'
      and ((e ->> 'time') = '' or (e ->> 'time') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')
      and (not (e ? 'endTime') or (e ->> 'endTime') = '' or (
        pg_catalog.jsonb_typeof(e -> 'endTime') = 'string'
        and (e ->> 'endTime') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
        and (e ->> 'time') <> '' and (e ->> 'endTime') > (e ->> 'time')))
      and (not (e ? 'important') or pg_catalog.jsonb_typeof(e -> 'important') = 'boolean')
      and (e ->> 'type') in ('filming','rehearsal','show','teahouse','concert','personal'), false) then return false; end if;
    event_date := (e ->> 'date')::date;
    if pg_catalog.to_char(event_date,'YYYY-MM-DD') <> e ->> 'date' then return false; end if;
  end loop;
  foreach ids in array array[value -> 'hiddenShows',value -> 'importantShows'] loop
    if pg_catalog.jsonb_array_length(ids) > 2000 then return false; end if;
    for e in select x.value from pg_catalog.jsonb_array_elements(ids) x loop
      if not coalesce(pg_catalog.jsonb_typeof(e) = 'string' and (e #>> '{}') ~ '^theater-[a-z0-9-]{1,80}$',false) then return false; end if;
    end loop;
  end loop;
  return true;
exception when others then return false;
end;
$$;
revoke all on function antrakt_private.valid_account_data(jsonb) from public, anon, authenticated;

create or replace function public.antrakt_account_sign_in(account_name text, pin_code text, create_account boolean default false)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  display_name text := pg_catalog.regexp_replace(pg_catalog.btrim(account_name),'\s+',' ','g');
  name_key text := pg_catalog.lower(display_name);
  instant timestamptz := pg_catalog.clock_timestamp();
  limits antrakt_private.account_attempts%rowtype;
  person antrakt_private.accounts%rowtype;
  access_token text;
  expiry timestamptz;
begin
  if not coalesce(pg_catalog.length(display_name) between 2 and 40
    and display_name ~ '^[[:alnum:]А-Яа-яЁё _.-]+$' and pin_code ~ '^[0-9]{4}$',false) then
    return pg_catalog.jsonb_build_object('error','input');
  end if;
  -- A global budget bounds account creation. The per-name budget protects PINs.
  insert into antrakt_private.account_attempts(bucket) values ('!global') on conflict do nothing;
  select * into limits from antrakt_private.account_attempts where bucket = '!global' for update;
  if limits.started_at <= instant - interval '15 minutes' then
    update antrakt_private.account_attempts set attempts = 0, started_at = instant where bucket = '!global';
    limits.attempts := 0;
  end if;
  if limits.attempts >= 200 then return pg_catalog.jsonb_build_object('error','limited'); end if;
  update antrakt_private.account_attempts set attempts = attempts + 1 where bucket = '!global';
  insert into antrakt_private.account_attempts(bucket) values ('name:' || name_key) on conflict do nothing;
  select * into limits from antrakt_private.account_attempts where bucket = 'name:' || name_key for update;
  if limits.started_at <= instant - interval '15 minutes' then
    update antrakt_private.account_attempts set attempts = 0, started_at = instant where bucket = 'name:' || name_key;
    limits.attempts := 0;
  end if;
  if limits.attempts >= 5 then return pg_catalog.jsonb_build_object('error','limited'); end if;
  select * into person from antrakt_private.accounts where username_key = name_key for update;
  if create_account then
    if person.id is not null then return pg_catalog.jsonb_build_object('error','exists'); end if;
    insert into antrakt_private.accounts(username,username_key,pin_hash)
    values (display_name,name_key,extensions.crypt(pin_code,extensions.gen_salt('bf',10))) returning * into person;
  else
    if person.id is null then
      perform extensions.crypt(pin_code,extensions.gen_salt('bf',10));
      update antrakt_private.account_attempts set attempts = attempts + 1 where bucket = 'name:' || name_key;
      return pg_catalog.jsonb_build_object('error','credentials');
    end if;
    if person.pin_hash <> extensions.crypt(pin_code,person.pin_hash) then
      update antrakt_private.account_attempts set attempts = attempts + 1 where bucket = 'name:' || name_key;
      return pg_catalog.jsonb_build_object('error','credentials');
    end if;
  end if;
  update antrakt_private.account_attempts set attempts = 0, started_at = instant where bucket = 'name:' || name_key;
  delete from antrakt_private.account_sessions where expires_at <= instant;
  delete from antrakt_private.account_attempts where started_at < instant - interval '1 day' and bucket <> '!global';
  access_token := pg_catalog.encode(extensions.gen_random_bytes(32),'hex');
  expiry := instant + interval '30 days';
  insert into antrakt_private.account_sessions(token_hash,account_id,expires_at)
  values (pg_catalog.sha256(pg_catalog.convert_to(access_token,'UTF8')),person.id,expiry);
  return pg_catalog.jsonb_build_object('token',access_token,'expiresAt',expiry,'username',person.username,'revision',person.revision,'data',person.data);
end;
$$;

create or replace function public.antrakt_account_read(session_token text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce((
    select pg_catalog.jsonb_build_object('username',a.username,'revision',a.revision,'data',a.data)
    from antrakt_private.account_sessions s join antrakt_private.accounts a on a.id = s.account_id
    where session_token ~ '^[a-f0-9]{64}$' and s.token_hash = pg_catalog.sha256(pg_catalog.convert_to(session_token,'UTF8')) and s.expires_at > now()
  ),pg_catalog.jsonb_build_object('error','session'));
$$;

create or replace function public.antrakt_account_write(session_token text, expected_revision integer, next_data jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare person_id uuid; next_revision integer;
begin
  select s.account_id into person_id from antrakt_private.account_sessions s
  where session_token ~ '^[a-f0-9]{64}$' and s.token_hash = pg_catalog.sha256(pg_catalog.convert_to(session_token,'UTF8')) and s.expires_at > now();
  if person_id is null then return pg_catalog.jsonb_build_object('error','session'); end if;
  if not antrakt_private.valid_account_data(next_data) then return pg_catalog.jsonb_build_object('error','input'); end if;
  update antrakt_private.accounts a set data = next_data, revision = a.revision + 1
  where a.id = person_id and a.revision = expected_revision returning a.revision into next_revision;
  if next_revision is null then return pg_catalog.jsonb_build_object('conflict',true); end if;
  return pg_catalog.jsonb_build_object('revision',next_revision);
end;
$$;

create or replace function public.antrakt_account_sign_out(session_token text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
begin
  delete from antrakt_private.account_sessions s
  where session_token ~ '^[a-f0-9]{64}$' and s.token_hash = pg_catalog.sha256(pg_catalog.convert_to(session_token,'UTF8'));
  return pg_catalog.jsonb_build_object('ok',true);
end;
$$;

revoke all on function public.antrakt_account_sign_in(text,text,boolean), public.antrakt_account_read(text), public.antrakt_account_write(text,integer,jsonb), public.antrakt_account_sign_out(text) from public, anon, authenticated;
grant execute on function public.antrakt_account_sign_in(text,text,boolean), public.antrakt_account_read(text), public.antrakt_account_write(text,integer,jsonb), public.antrakt_account_sign_out(text) to anon, authenticated;
commit;
