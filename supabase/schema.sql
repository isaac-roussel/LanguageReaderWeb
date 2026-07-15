-- Language Reader Web schema
-- Run this in the Supabase SQL editor.

create extension if not exists pgcrypto;

create table if not exists public.invites (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  code text not null unique,
  accepted_by uuid references auth.users(id) on delete set null,
  accepted_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.lexicons (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  title text not null default 'My Lexicon',
  target_language text not null default 'auto',
  native_language text not null default 'en',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.lexicon_entries (
  id uuid primary key default gen_random_uuid(),
  lexicon_id uuid not null references public.lexicons(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  target text not null,
  normalized_key text not null,
  native text[] not null default '{}',
  status integer not null default 1 check (status between 0 and 4),
  scope text not null default 'word' check (scope in ('word','phrase')),
  notes text not null default '',
  review jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (lexicon_id, normalized_key)
);

create table if not exists public.texts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  content text not null,
  target_language text not null default 'auto',
  last_sentence_index integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.user_settings (
  owner_id uuid primary key references auth.users(id) on delete cascade,
  active_lexicon_id uuid references public.lexicons(id) on delete set null,
  active_text_id uuid references public.texts(id) on delete set null,
  settings jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists lexicons_touch_updated_at on public.lexicons;
create trigger lexicons_touch_updated_at before update on public.lexicons for each row execute function public.touch_updated_at();

drop trigger if exists lexicon_entries_touch_updated_at on public.lexicon_entries;
create trigger lexicon_entries_touch_updated_at before update on public.lexicon_entries for each row execute function public.touch_updated_at();

drop trigger if exists texts_touch_updated_at on public.texts;
create trigger texts_touch_updated_at before update on public.texts for each row execute function public.touch_updated_at();

alter table public.invites enable row level security;
alter table public.lexicons enable row level security;
alter table public.lexicon_entries enable row level security;
alter table public.texts enable row level security;
alter table public.user_settings enable row level security;

create policy "invite lookup during signup" on public.invites for select using (accepted_at is null);
create policy "invite accept by authenticated user" on public.invites for update using (auth.uid() is not null and accepted_at is null) with check (auth.uid() is not null);

create policy "own lexicons" on public.lexicons for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy "own entries" on public.lexicon_entries for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy "own texts" on public.texts for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy "own settings" on public.user_settings for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());
