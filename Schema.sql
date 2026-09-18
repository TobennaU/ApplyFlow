
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create type public.application_status as enum (
  'Applied',
  'Interview',
  'Offer',
  'Rejected'
);


-- Supabase Auth owns auth.users. 
create table public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  name       text,
  email      text,
  created_at timestamptz not null default now()
);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, name, email)
  values (new.id, new.raw_user_meta_data ->> 'name', new.email);
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();


create table public.job_listings (
  id          uuid primary key default gen_random_uuid(),
  title       text not null,
  company     text not null,
  location    text,
  description text,
  job_url     text unique,
  source      text,
  created_at  timestamptz not null default now()
);

create index job_listings_company_idx on public.job_listings (company);
create index job_listings_created_at_idx on public.job_listings (created_at desc);


create table public.applications (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references public.profiles (id) on delete cascade,
  job_listing_id     uuid references public.job_listings (id) on delete set null,
  job_title          text not null,
  company            text not null,
  location           text,
  job_description    text,
  notes              text,
  application_status public.application_status not null default 'Applied',
  application_date   date not null default current_date,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index applications_user_id_idx on public.applications (user_id);
create index applications_status_idx on public.applications (user_id, application_status);

create trigger applications_set_updated_at
  before update on public.applications
  for each row execute function public.set_updated_at();


-- file_path points at an object in the 'resumes' storage bucket
create table public.resumes (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles (id) on delete cascade,
  file_name   text not null,
  file_path   text not null,
  parsed_text text,
  uploaded_at timestamptz not null default now()
);

create index resumes_user_id_idx on public.resumes (user_id);


create table public.saved_jobs (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.profiles (id) on delete cascade,
  job_listing_id uuid not null references public.job_listings (id) on delete cascade,
  saved_at       timestamptz not null default now(),
  unique (user_id, job_listing_id)
);

create index saved_jobs_user_id_idx on public.saved_jobs (user_id);


create table public.match_results (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.profiles (id) on delete cascade,
  resume_id      uuid not null references public.resumes (id) on delete cascade,
  job_listing_id uuid not null references public.job_listings (id) on delete cascade,
  match_score    numeric(5,2) check (match_score between 0 and 100),
  analysis       jsonb,
  created_at     timestamptz not null default now(),
  unique (resume_id, job_listing_id)
);

create index match_results_user_id_idx on public.match_results (user_id);


-- Row Level Security

alter table public.profiles      enable row level security;
alter table public.applications  enable row level security;
alter table public.resumes       enable row level security;
alter table public.saved_jobs    enable row level security;
alter table public.match_results enable row level security;
alter table public.job_listings  enable row level security;

create policy "own profile: select" on public.profiles
  for select to authenticated using ((select auth.uid()) = id);

create policy "own profile: update" on public.profiles
  for update to authenticated using ((select auth.uid()) = id);

create policy "own applications: select" on public.applications
  for select to authenticated using ((select auth.uid()) = user_id);

create policy "own applications: insert" on public.applications
  for insert to authenticated with check ((select auth.uid()) = user_id);

create policy "own applications: update" on public.applications
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "own applications: delete" on public.applications
  for delete to authenticated using ((select auth.uid()) = user_id);

create policy "own resumes: select" on public.resumes
  for select to authenticated using ((select auth.uid()) = user_id);

create policy "own resumes: insert" on public.resumes
  for insert to authenticated with check ((select auth.uid()) = user_id);

create policy "own resumes: update" on public.resumes
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "own resumes: delete" on public.resumes
  for delete to authenticated using ((select auth.uid()) = user_id);

create policy "own saved jobs: select" on public.saved_jobs
  for select to authenticated using ((select auth.uid()) = user_id);

create policy "own saved jobs: insert" on public.saved_jobs
  for insert to authenticated with check ((select auth.uid()) = user_id);

create policy "own saved jobs: delete" on public.saved_jobs
  for delete to authenticated using ((select auth.uid()) = user_id);

-- no insert policy: scores are written by an Edge Function, which bypasses RLS
create policy "own match results: select" on public.match_results
  for select to authenticated using ((select auth.uid()) = user_id);

create policy "job listings: read" on public.job_listings
  for select to authenticated using (true);

create policy "job listings: insert" on public.job_listings
  for insert to authenticated with check (true);


-- Storage. Make a private bucket called 'resumes' first.
-- Files go at '<user_id>/<filename>' so the folder name is the owner.

create policy "resumes: read own files" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'resumes'
    and (select auth.uid())::text = (storage.foldername(name))[1]
  );

create policy "resumes: upload own files" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'resumes'
    and (select auth.uid())::text = (storage.foldername(name))[1]
  );

create policy "resumes: delete own files" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'resumes'
    and (select auth.uid())::text = (storage.foldername(name))[1]
  );