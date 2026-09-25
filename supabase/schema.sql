create extension if not exists pgcrypto;

create table if not exists public.users (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null,
  phone_number text not null unique,
  location_label text not null,
  latitude double precision not null,
  longitude double precision not null,
  alert_enabled boolean not null default true,
  sms_enabled boolean not null default true,
  call_enabled boolean not null default false,
  consent boolean not null default false,
  consent_at timestamptz,
  current_risk_level text,
  current_risk_score integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.weather_alerts (
  id uuid primary key default gen_random_uuid(),
  location_label text not null,
  latitude double precision not null,
  longitude double precision not null,
  temperature_c double precision not null,
  risk_level text not null,
  risk_score integer not null,
  message text not null,
  automatic boolean not null default false,
  test_mode boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.alert_recipients (
  id uuid primary key default gen_random_uuid(),
  alert_id uuid not null references public.weather_alerts(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  phone_number text not null,
  sms_status text not null default 'NOT_SELECTED',
  call_status text not null default 'NOT_SELECTED',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(alert_id, user_id)
);

create table if not exists public.notification_logs (
  id uuid primary key default gen_random_uuid(),
  alert_id uuid not null references public.weather_alerts(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  recipient_id uuid not null references public.alert_recipients(id) on delete cascade,
  phone_number text not null,
  channel text not null check (channel in ('sms', 'call')),
  provider text not null default 'exotel',
  provider_message_id text,
  status text not null,
  error text,
  location_key text,
  risk_level text,
  automatic boolean not null default false,
  raw_payload jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists users_location_idx on public.users(latitude, longitude);
create index if not exists users_alert_idx on public.users(alert_enabled, consent);
create index if not exists weather_alerts_created_idx on public.weather_alerts(created_at desc);
create index if not exists notification_logs_provider_idx on public.notification_logs(provider_message_id);
create index if not exists notification_logs_dedupe_idx on public.notification_logs(user_id, location_key, risk_level, created_at desc);

alter table public.users enable row level security;
alter table public.weather_alerts enable row level security;
alter table public.alert_recipients enable row level security;
alter table public.notification_logs enable row level security;

-- THRIVE uses the Supabase service-role key only from Vercel server functions.
-- No public/anon policies are intentionally created.
