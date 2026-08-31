create table if not exists agent_settings (
  agent_account text primary key,
  enabled boolean not null default true,
  min_health_factor numeric not null default 1.5,
  updated_at timestamptz not null default now()
);

create table if not exists agent_cycles (
  id bigint generated always as identity primary key,
  cycle_id text,
  agent_account text not null,
  occurred_at timestamptz not null,
  status text not null,
  action text,
  amount numeric,
  rationale text,
  reason text,
  error text,
  transaction_hash text
);

alter table agent_cycles add column if not exists cycle_id text;

create index if not exists agent_cycles_account_time_idx on agent_cycles (agent_account, occurred_at desc);

create table if not exists wallet_sessions (
  token_hash text primary key,
  wallet_address text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create index if not exists wallet_sessions_wallet_idx on wallet_sessions (wallet_address);

create table if not exists wallet_agents (
  wallet_address text primary key,
  agent_account text not null unique,
  created_at timestamptz not null default now(),
  active boolean not null default true
);

create table if not exists agent_signers (
  wallet_address text primary key,
  agent_account text not null unique,
  signer_address text not null,
  encrypted_private_key text not null,
  encryption_iv text not null,
  encryption_auth_tag text not null,
  created_at timestamptz not null default now(),
  rotated_at timestamptz
);

create index if not exists agent_signers_account_idx on agent_signers (agent_account);

alter table agent_settings enable row level security;
alter table agent_cycles enable row level security;
alter table wallet_sessions enable row level security;
alter table wallet_agents enable row level security;
alter table agent_signers enable row level security;

create table if not exists service_events (
  id bigint generated always as identity primary key,
  event_type text not null,
  severity text not null default 'info',
  agent_account text,
  cycle_id text,
  message text,
  metadata jsonb,
  occurred_at timestamptz not null default now()
);

create index if not exists service_events_time_idx on service_events (occurred_at desc);
alter table service_events enable row level security;
