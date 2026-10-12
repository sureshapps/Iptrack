-- IP Tracker — run once in Supabase → SQL Editor

create table public.profiles (
  id uuid primary key references auth.users on delete cascade,
  display_name text not null default 'User',
  email text not null,
  role text not null default 'user' check (role in ('user','admin')),
  retention_days int not null default 90,
  created_at timestamptz not null default now()
);

create table public.tracking_links (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles on delete cascade,
  slug text not null unique check (slug ~ '^[A-Za-z0-9_-]{3,32}$'),
  tracking_code_hash text not null,
  destination_url text not null check (destination_url ~ '^(https?://[^\s]+|pixel:)$'),
  title text, purpose text,
  link_type text not null check (link_type in ('short_url','pixel','geolocation')),
  status text not null default 'active' check (status in ('active','disabled','removed')),
  expires_at timestamptz,
  retention_days int not null default 90 check (retention_days > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on public.tracking_links(owner_id);

create table public.tracking_events (
  id uuid primary key default gen_random_uuid(),
  link_id uuid not null references public.tracking_links on delete cascade,
  event_type text not null check (event_type in ('visit','pixel_load')),
  occurred_at timestamptz not null default now(),
  ip_masked text, visitor_token text,
  country text, country_code text, region text, city text,
  lat double precision, lng double precision,
  browser text, operating_system text, device_type text,
  referrer text, language text,
  utm_source text, utm_medium text, utm_campaign text,
  proxy_indicators jsonb,
  consent_status text not null default 'n/a'
);
create index on public.tracking_events(link_id, occurred_at desc);

create table public.geolocation_consents (
  id uuid primary key default gen_random_uuid(),
  tracking_link_id uuid not null references public.tracking_links on delete cascade,
  consent_token_hash text not null,
  purpose text,
  disclosure_version text not null default 'v1.2',
  consented_at timestamptz not null default now(),
  withdrawn_at timestamptz,
  expires_at timestamptz not null
);

create table public.geolocation_events (
  id uuid primary key default gen_random_uuid(),
  tracking_link_id uuid not null references public.tracking_links on delete cascade,
  consent_id uuid references public.geolocation_consents on delete cascade,
  latitude double precision not null,
  longitude double precision not null,
  accuracy_meters int,
  captured_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table public.tracking_reports (
  id uuid primary key default gen_random_uuid(),
  tracking_link_id uuid not null references public.tracking_links on delete cascade,
  reporter_reference text,
  reason text not null,
  description text not null,
  status text not null default 'pending' check (status in ('pending','dismissed','actioned')),
  reviewed_by uuid, reviewed_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid, action text not null,
  resource_type text, resource_id uuid,
  created_at timestamptz not null default now()
);

-- helpers
create function public.is_admin() returns boolean language sql security definer stable set search_path = public as
$$ select exists (select 1 from profiles where id = auth.uid() and role = 'admin') $$;

create function public.owns_link(l uuid) returns boolean language sql security definer stable set search_path = public as
$$ select exists (select 1 from tracking_links where id = l and owner_id = auth.uid()) $$;

-- row level security (anonymous visitors get NO table access; they go through the edge function)
alter table public.profiles enable row level security;
alter table public.tracking_links enable row level security;
alter table public.tracking_events enable row level security;
alter table public.geolocation_consents enable row level security;
alter table public.geolocation_events enable row level security;
alter table public.tracking_reports enable row level security;
alter table public.audit_logs enable row level security;

create policy profiles_select on public.profiles for select using (id = auth.uid() or is_admin());
create policy profiles_update on public.profiles for update using (id = auth.uid()) with check (id = auth.uid());
revoke update on public.profiles from authenticated;
grant update (display_name, retention_days) on public.profiles to authenticated;  -- users can never change their own role

create policy links_select on public.tracking_links for select using (owner_id = auth.uid() or is_admin());
create policy links_insert on public.tracking_links for insert with check (owner_id = auth.uid());
create policy links_update on public.tracking_links for update using (owner_id = auth.uid() or is_admin()) with check (owner_id = auth.uid() or is_admin());
create policy links_delete on public.tracking_links for delete using (owner_id = auth.uid() or is_admin());

create policy ev_select on public.tracking_events for select using (owns_link(link_id) or is_admin());
create policy ev_delete on public.tracking_events for delete using (owns_link(link_id));
create policy ge_select on public.geolocation_events for select using (owns_link(tracking_link_id) or is_admin());
create policy ge_delete on public.geolocation_events for delete using (owns_link(tracking_link_id));
create policy gc_select on public.geolocation_consents for select using (owns_link(tracking_link_id) or is_admin());
create policy gc_delete on public.geolocation_consents for delete using (owns_link(tracking_link_id));
create policy rep_select on public.tracking_reports for select using (owns_link(tracking_link_id) or is_admin());
create policy rep_update on public.tracking_reports for update using (is_admin()) with check (is_admin());
create policy audit_select on public.audit_logs for select using (is_admin());

-- profile on signup
create function public.handle_new_user() returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id, email, display_name)
  values (new.id, new.email, coalesce(nullif(new.raw_user_meta_data->>'display_name',''), split_part(new.email,'@',1)));
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

-- audit trail
create function public.log_audit() returns trigger language plpgsql security definer set search_path = public as $$
declare r jsonb := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
begin
  insert into audit_logs (actor_id, action, resource_type, resource_id)
  values (auth.uid(), lower(tg_table_name || '.' || tg_op || coalesce('.' || (r->>'status'), '')), tg_table_name, (r->>'id')::uuid);
  return case when tg_op = 'DELETE' then old else new end;
end $$;
create trigger audit_links after insert or update or delete on public.tracking_links for each row execute function public.log_audit();
create trigger audit_reports after update on public.tracking_reports for each row execute function public.log_audit();

-- self-service account deletion
create function public.delete_my_account() returns void language sql security definer set search_path = public as
$$ delete from auth.users where id = auth.uid() $$;
revoke execute on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;

-- OPTIONAL retention purge: first enable Database → Extensions → pg_cron, then run:
-- select cron.schedule('retention-purge', '17 3 * * *', $$
--   delete from tracking_events e using tracking_links l where e.link_id = l.id and e.occurred_at < now() - make_interval(days => l.retention_days);
--   delete from geolocation_events g using tracking_links l where g.tracking_link_id = l.id and g.captured_at < now() - make_interval(days => l.retention_days);
--   delete from geolocation_consents where expires_at < now();
-- $$);
