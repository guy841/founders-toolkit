-- HelpBnk — Supabase schema for end-to-end encrypted cross-device sync.
-- Paste this whole file into the Supabase SQL editor and run it once.
--
-- Design: ONE row per user, holding only an opaque AES-GCM ciphertext + its IV.
-- The encryption key never leaves the user's device, so the server (and we)
-- cannot read the contents. Row-Level Security guarantees a signed-in user can
-- only ever touch their own row.

create table if not exists public.vaults (
  user_id    uuid        primary key references auth.users (id) on delete cascade,
  ciphertext text        not null,
  iv         text        not null,
  keys       jsonb,      -- wrapped Data Encryption Key: { v, pw:{iv,ct}, rec:{iv,ct} }
  updated_at timestamptz not null default now()
);

-- For existing projects created before the recovery-key feature:
alter table public.vaults add column if not exists keys jsonb;

-- Keep updated_at server-authoritative: default now() on insert, and bump it on
-- every update (the client never sends a timestamp, so clocks can't be trusted
-- or spoofed, and last-write-wins comparisons stay consistent).
create or replace function public.vaults_touch_updated_at()
  returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists vaults_set_updated_at on public.vaults;
create trigger vaults_set_updated_at
  before update on public.vaults
  for each row execute function public.vaults_touch_updated_at();

alter table public.vaults enable row level security;

-- Owner-only access. auth.uid() is the id of the currently signed-in user.
drop policy if exists "vaults_select_own" on public.vaults;
create policy "vaults_select_own" on public.vaults
  for select using (auth.uid() = user_id);

drop policy if exists "vaults_insert_own" on public.vaults;
create policy "vaults_insert_own" on public.vaults
  for insert with check (auth.uid() = user_id);

drop policy if exists "vaults_update_own" on public.vaults;
create policy "vaults_update_own" on public.vaults
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "vaults_delete_own" on public.vaults;
create policy "vaults_delete_own" on public.vaults
  for delete using (auth.uid() = user_id);

-- Table-level privileges for the Data API. Only the "authenticated" role gets
-- access (RLS above still restricts every row to its owner); "anon" gets nothing,
-- since only signed-in users sync. These explicit grants are REQUIRED when the
-- project's "Automatically expose new tables" setting is OFF (the recommended,
-- more secure posture) — with them, you can safely leave that setting disabled.
grant select, insert, update, delete on public.vaults to authenticated;
revoke all on public.vaults from anon;

-- Optional: let a signed-in user delete their own auth account (and, via the
-- cascade above, their vault) entirely from the client. Safe because it only
-- ever deletes the caller's own account.
create or replace function public.delete_my_account()
  returns void
  language sql
  security definer
  set search_path = public
as $$
  delete from auth.users where id = auth.uid();
$$;

revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;
