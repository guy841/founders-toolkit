-- Helm — Supabase schema for end-to-end encrypted cross-device sync.
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
  updated_at timestamptz not null default now()
);

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
