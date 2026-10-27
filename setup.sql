-- Выполните один раз в Supabase: SQL Editor → New query → Run
create table if not exists items (
    user_id    uuid    not null default auth.uid() references auth.users(id) on delete cascade,
    id         text    not null check (id ~ '^[A-Za-z0-9_-]{1,64}$'),
    kind       text    not null check (kind in ('note','folder')),
    data       jsonb   not null check (octet_length(data::text) < 60000),
    updated_at bigint  not null,
    deleted    boolean not null default false,
    synced_at  timestamptz not null default clock_timestamp(),
    primary key (user_id, id)
);

create or replace function set_synced_at() returns trigger
language plpgsql as $$ begin new.synced_at = clock_timestamp(); return new; end $$;

drop trigger if exists items_synced on items;
create trigger items_synced before insert or update on items
for each row execute function set_synced_at();

create index if not exists items_user_synced on items (user_id, synced_at);

-- Защита: каждый видит и меняет только свои строки
alter table items enable row level security;
drop policy if exists "own items" on items;
create policy "own items" on items
    for all to authenticated
    using (auth.uid() = user_id)
    with check (auth.uid() = user_id);
