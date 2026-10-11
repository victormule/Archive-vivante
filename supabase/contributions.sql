-- Contributions du public (volet « Impressions du public » de l'Event, formulaire /participer/).
-- À coller dans Supabase → SQL Editor → Run. Rejouable : chaque objet est recréé ou mis à jour.
--
-- Publication immédiate, sans modération : le public ajoute et lit, rien d'autre.
-- Retirer une contribution : supprimer sa ligne (Table Editor) ; elle disparaît en direct
-- des écrans. Ses fichiers restent dans le bucket « contributions » (à supprimer à la main).

-- ---------- Table ----------

create table if not exists public.contributions (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  author text not null,
  message text not null default '',
  media_kind text,
  media_path text,
  thumb_path text,
  media_width integer,
  media_height integer
);

alter table public.contributions drop constraint if exists contributions_author_check;
alter table public.contributions add constraint contributions_author_check
  check (char_length(author) between 1 and 40);
alter table public.contributions drop constraint if exists contributions_message_check;
alter table public.contributions add constraint contributions_message_check
  check (char_length(message) <= 1000);
alter table public.contributions drop constraint if exists contributions_media_check;
alter table public.contributions add constraint contributions_media_check check (
  (media_kind is null and media_path is null and thumb_path is null)
  or (
    media_kind in ('image', 'video')
    and media_path ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(webp|jpg|mp4|webm)$'
    and thumb_path ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-thumb\.(webp|jpg)$'
  )
);
-- Un message vide n'est accepté qu'accompagné d'un média
alter table public.contributions drop constraint if exists contributions_content_check;
alter table public.contributions add constraint contributions_content_check
  check (char_length(message) > 0 or media_path is not null);
alter table public.contributions drop constraint if exists contributions_size_check;
alter table public.contributions add constraint contributions_size_check
  check (media_width is null or (media_width between 1 and 4096 and media_height between 1 and 4096));

create index if not exists contributions_created_at_idx on public.contributions (created_at desc);

-- ---------- Nettoyage et limite de débit ----------

create or replace function public.contributions_before_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Garde-fou contre l'envoi en masse (robot) : au plus 30 contributions par minute, tous publics confondus
  if (select count(*) from public.contributions where created_at > now() - interval '1 minute') >= 30 then
    raise exception 'Trop de contributions en ce moment, réessayez dans une minute.';
  end if;
  new.author := btrim(new.author);
  new.message := btrim(new.message);
  new.created_at := now();
  return new;
end;
$$;

drop trigger if exists contributions_before_insert on public.contributions;
create trigger contributions_before_insert
  before insert on public.contributions
  for each row execute function public.contributions_before_insert();

-- ---------- Droits ----------

alter table public.contributions enable row level security;

drop policy if exists "Lecture publique" on public.contributions;
create policy "Lecture publique" on public.contributions
  for select to anon, authenticated using (true);

drop policy if exists "Ajout public" on public.contributions;
create policy "Ajout public" on public.contributions
  for insert to anon, authenticated with check (true);

-- Le public ne choisit ni l'identifiant ni la date ; il ne modifie ni ne supprime rien
revoke all on public.contributions from anon, authenticated;
grant select on public.contributions to anon, authenticated;
grant insert (author, message, media_kind, media_path, thumb_path, media_width, media_height)
  on public.contributions to anon, authenticated;

-- ---------- Temps réel ----------

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'contributions'
  ) then
    alter publication supabase_realtime add table public.contributions;
  end if;
end;
$$;

-- ---------- Médias ----------

-- Bucket public en lecture ; 10 Mo et formats limités côté serveur
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('contributions', 'contributions', true, 10485760,
        array['image/webp', 'image/jpeg', 'video/mp4', 'video/webm'])
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Dépôt seulement (ni remplacement, ni suppression), noms générés par le formulaire
drop policy if exists "Dépôt public des contributions" on storage.objects;
create policy "Dépôt public des contributions" on storage.objects
  for insert to anon, authenticated
  with check (
    bucket_id = 'contributions'
    and name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(-thumb)?\.(webp|jpg|mp4|webm)$'
  );
