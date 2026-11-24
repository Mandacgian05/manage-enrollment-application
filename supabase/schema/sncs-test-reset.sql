-- ============================================================================
-- SNCS TEST DATABASE - remove the old (v11, snake_case) structure from sncs-test
-- Run ONLY in the sncs-test project, before sncs-schema-v12.sql.
-- Keeps the five sign-ins in Authentication > Users and the storage folders.
-- SAFETY: stops unless every staff record belongs to one of the five test accounts,
-- so running it in the main project changes nothing.
-- ============================================================================

begin;

do $$
begin
    if to_regclass('public.users') is null then
        raise exception 'Nothing to reset: this project has no SNCS tables.';
    end if;
    if exists (
        select 1 from public.users
        where lower(email) not in ('superadmin1@gmail.com', 'gsmandac@student.apc.edu.ph', 'jansultan905@gmail.com',
                                   'miles123@gmail.com', 'tcorpuz@gmail.com')
    ) then
        raise exception 'STOP: this project has staff accounts other than the five test accounts. It may be the main project.';
    end if;
end $$;

drop trigger if exists chimera_link_provisioned_staff on auth.users;
drop trigger if exists chimera_sync_staff_auth_action on auth.users;

drop policy if exists "Admins read CMS files" on storage.objects;
drop policy if exists "Admins upload CMS files" on storage.objects;
drop policy if exists "Admins replace CMS files" on storage.objects;
drop policy if exists "Admins remove CMS files" on storage.objects;

drop schema if exists sncs_scheduler cascade;

do $$
declare
    t text;
    f regprocedure;
begin
    for t in select tablename from pg_tables where schemaname = 'public' loop
        execute format('drop table if exists public.%I cascade', t);
    end loop;
    for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public' and p.prokind = 'f' loop
        execute format('drop function if exists %s cascade', f);
    end loop;
end $$;

commit;

select count(*) as tables_left from pg_tables where schemaname = 'public';
