-- ============================================================================
-- SNCS TEST DATABASE PATCH (sncs-test only) - 2026-11-25
-- 1. Temporary privilege grants (PB-05 / US-14 criteria 4, 5 and 7)
-- 2. Access checks that honour active grants (and upload access for website files)
-- 3. The website's existing announcements and events copied into "cmsContent" (PB-01)
--
-- HOW TO USE: run once in the sncs-test SQL editor, after
-- 2026-11-25-account-admin-create-only.sql. Safe to run again.
-- ============================================================================

begin;

-- 1. TABLE ---------------------------------------------------------------------
-- A Super Admin lends one privilege to another Admin until an end date, with a reason.
-- The grant stops working by itself at "expiresAt", or earlier when revoked.
create table if not exists public."privilegeGrants" (
    "grantId"   bigint generated always as identity primary key,
    "userId"    bigint not null references public."users"("userId") on delete cascade,
    "privilege" varchar(30) not null check ("privilege" in ('manageStaffAccounts', 'manageContent')),
    "reason"    varchar(300) not null check (length(btrim("reason")) >= 5),
    "expiresAt" timestamptz not null,
    "grantedBy" bigint not null references public."users"("userId"),
    "grantedAt" timestamptz not null default now(),
    "revokedAt" timestamptz,
    "revokedBy" bigint references public."users"("userId"),
    check ("expiresAt" > "grantedAt"),
    check (("revokedAt" is null) = ("revokedBy" is null))
);
create index if not exists "privilegeGrantsUserPrivilege" on public."privilegeGrants" ("userId", "privilege");
alter table public."privilegeGrants" enable row level security;
revoke all on public."privilegeGrants" from public, anon, authenticated;

-- 2. ACCESS CHECKS -------------------------------------------------------------
-- True while the given sign-in holds an unexpired, unrevoked grant and is an active Admin.
create or replace function public.has_active_grant(p_user_id uuid, p_privilege text)
returns boolean language sql stable security definer set search_path = ''
as $$
    select exists (
        select 1 from public."privilegeGrants" g
        join public."users" u on u."userId" = g."userId"
        where u."authUserId" = p_user_id and u."role" = 'admin' and u."status" = 'active'
          and not u."mustChangePassword"
          and g."privilege" = p_privilege and g."revokedAt" is null and g."expiresAt" > now()
    );
$$;

-- Website content: Super Admins, Content Admins, and Admins with an active manageContent grant.
create or replace function public.has_content_admin_access()
returns boolean language sql stable security definer set search_path = ''
as $$
    select public.has_active_admin_access() and (
        exists (select 1 from public."users" where "authUserId" = auth.uid() and "adminType" in ('superAdmin', 'contentAdmin'))
        or public.has_active_grant(auth.uid(), 'manageContent'));
$$;

-- Staff accounts: Super Admins, Account Admins, and Admins with an active manageStaffAccounts
-- grant. With no signed-in user (server key) it checks the given account only.
create or replace function public.can_manage_staff_accounts(p_user_id uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
    select (auth.uid() is null or (auth.uid() = p_user_id and public.has_live_staff_session())) and exists (
        select 1 from public."users"
        where "authUserId" = p_user_id and "role" = 'admin' and "status" = 'active' and not "mustChangePassword"
          and ("adminType" in ('superAdmin', 'accountAdmin') or public.has_active_grant(p_user_id, 'manageStaffAccounts'))
    );
$$;

-- What the signed-in Admin may open. temporaryAccess lists active grants with their end dates.
create or replace function public.get_admin_access()
returns jsonb language sql stable security definer set search_path = ''
as $$
    select jsonb_build_object('adminType', u."adminType",
        'manageAccounts', u."adminType" in ('superAdmin', 'accountAdmin') or public.has_active_grant(u."authUserId", 'manageStaffAccounts'),
        'manageStaff', u."adminType" = 'superAdmin',
        'manageContent', u."adminType" in ('superAdmin', 'contentAdmin') or public.has_active_grant(u."authUserId", 'manageContent'),
        'temporaryAccess', coalesce((
            select jsonb_agg(jsonb_build_object('privilege', g."privilege", 'expiresAt', g."expiresAt") order by g."expiresAt")
            from public."privilegeGrants" g
            where g."userId" = u."userId" and g."revokedAt" is null and g."expiresAt" > now()), '[]'::jsonb))
    from public."users" u
    where u."authUserId" = auth.uid() and public.has_active_admin_access();
$$;

-- Create Account: the creator must be a Super Admin, an Account Admin, or hold an active
-- manageStaffAccounts grant. Super Admin is never created from the website.
create or replace function public.link_provisioned_staff()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
    provisioning jsonb := new.raw_app_meta_data -> 'chimera_staff_provisioning';
    creator_id uuid;
    staff_role text;
begin
    if provisioning is null then
        return new;
    end if;
    if tg_op = 'UPDATE' and provisioning is not distinct from
        (old.raw_app_meta_data -> 'chimera_staff_provisioning') then
        return new;
    end if;

    creator_id := (provisioning ->> 'createdBy')::uuid;
    perform 1 from public."users"
    where "authUserId" = creator_id and "role" = 'admin' and "status" = 'active' and not "mustChangePassword"
      and ("adminType" in ('superAdmin', 'accountAdmin') or public.has_active_grant(creator_id, 'manageStaffAccounts'))
    for update;
    if not found then
        raise insufficient_privilege using message = 'Staff account management access required';
    end if;
    staff_role := provisioning ->> 'role';
    if staff_role is null or staff_role not in ('accountAdmin', 'contentAdmin', 'registrar', 'teacher', 'academicCoordinator') then
        raise invalid_parameter_value using message = 'Unsupported staff role (Super Admin is set in the database only)';
    end if;

    insert into public."users" ("email", "firstName", "middleName", "lastName", "suffix", "role", "adminType", "authUserId")
    values (lower(new.email), provisioning ->> 'firstName', nullif(provisioning ->> 'middleName', ''),
            provisioning ->> 'lastName', nullif(provisioning ->> 'suffix', ''),
            case when staff_role in ('accountAdmin', 'contentAdmin') then 'admin' else staff_role end,
            case when staff_role in ('accountAdmin', 'contentAdmin') then staff_role end, new.id);
    return new;
end;
$$;

-- 3. GRANT, REVOKE, LIST (Super Admin only) ------------------------------------
-- Returns {granted: true, grantId} or, for an attempt on one's own account, {granted: false,
-- message}: that attempt is refused and still written to the audit log.
create or replace function public.grant_privilege(p_user_id bigint, p_privilege text, p_expires_at timestamptz, p_reason text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
    actor_id bigint;
    grantee record;
    new_id bigint;
begin
    if not public.is_super_admin(auth.uid()) then
        raise insufficient_privilege using message = 'Only a Super Admin can give temporary access';
    end if;
    select "userId" into actor_id from public."users" where "authUserId" = auth.uid();
    if p_privilege is null or p_privilege not in ('manageStaffAccounts', 'manageContent') then
        raise invalid_parameter_value using message = 'Unknown privilege';
    end if;
    if actor_id = p_user_id then
        insert into public."auditLogs" ("performedBy", "action", "entityType", "entityId", "newValue")
        values (actor_id, 'privilege.grant.rejected', 'users', p_user_id,
                jsonb_build_object('privilege', p_privilege, 'reason', 'Self-grant refused'));
        return jsonb_build_object('granted', false, 'message', 'You cannot change your own privileges.');
    end if;
    if length(btrim(coalesce(p_reason, ''))) < 5 or length(p_reason) > 300 then
        raise invalid_parameter_value using message = 'Give a reason of 5 to 300 characters';
    end if;
    if p_expires_at is null or p_expires_at <= now() then
        raise invalid_parameter_value using message = 'The end date must be in the future';
    end if;
    if p_expires_at > now() + interval '1 year' then
        raise invalid_parameter_value using message = 'Temporary access can last up to one year';
    end if;

    select "userId", "role", "adminType", "status" into grantee from public."users" where "userId" = p_user_id for update;
    if not found or grantee."status" <> 'active' then
        raise no_data_found using message = 'Choose an active staff account';
    end if;
    if grantee."role" <> 'admin' then
        raise invalid_parameter_value using message = 'Temporary access can be given to Admin accounts only';
    end if;
    if grantee."adminType" = 'superAdmin'
       or (p_privilege = 'manageStaffAccounts' and grantee."adminType" = 'accountAdmin')
       or (p_privilege = 'manageContent' and grantee."adminType" = 'contentAdmin') then
        raise invalid_parameter_value using message = 'This Admin already has this access';
    end if;
    if exists (select 1 from public."privilegeGrants" where "userId" = p_user_id and "privilege" = p_privilege
               and "revokedAt" is null and "expiresAt" > now()) then
        raise unique_violation using message = 'This Admin already has active temporary access of this kind. Revoke it first.';
    end if;

    insert into public."privilegeGrants" ("userId", "privilege", "reason", "expiresAt", "grantedBy")
    values (p_user_id, p_privilege, btrim(p_reason), p_expires_at, actor_id)
    returning "grantId" into new_id;
    insert into public."auditLogs" ("performedBy", "action", "entityType", "entityId", "newValue")
    values (actor_id, 'privilege.grant', 'privilegeGrants', new_id,
            jsonb_build_object('userId', p_user_id, 'privilege', p_privilege, 'reason', btrim(p_reason),
                               'expiresAt', p_expires_at, 'grantedAt', now()));
    return jsonb_build_object('granted', true, 'grantId', new_id);
end;
$$;

create or replace function public.revoke_privilege(p_grant_id bigint)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
    actor_id bigint;
    target record;
begin
    if not public.is_super_admin(auth.uid()) then
        raise insufficient_privilege using message = 'Only a Super Admin can revoke temporary access';
    end if;
    select "userId" into actor_id from public."users" where "authUserId" = auth.uid();
    select * into target from public."privilegeGrants" where "grantId" = p_grant_id for update;
    if not found then
        raise no_data_found using message = 'Temporary access not found';
    end if;
    if target."userId" = actor_id then
        insert into public."auditLogs" ("performedBy", "action", "entityType", "entityId", "newValue")
        values (actor_id, 'privilege.revoke.rejected', 'privilegeGrants', p_grant_id,
                jsonb_build_object('reason', 'Own privileges cannot be changed'));
        return jsonb_build_object('revoked', false, 'message', 'You cannot change your own privileges.');
    end if;
    if target."revokedAt" is not null or target."expiresAt" <= now() then
        return jsonb_build_object('revoked', false, 'message', 'This temporary access has already ended.');
    end if;
    update public."privilegeGrants" set "revokedAt" = now(), "revokedBy" = actor_id where "grantId" = p_grant_id;
    insert into public."auditLogs" ("performedBy", "action", "entityType", "entityId", "oldValue", "newValue")
    values (actor_id, 'privilege.revoke', 'privilegeGrants', p_grant_id,
            jsonb_build_object('userId', target."userId", 'privilege', target."privilege", 'expiresAt', target."expiresAt"),
            jsonb_build_object('revokedAt', now()));
    return jsonb_build_object('revoked', true);
end;
$$;

-- Newest first; "active" is worked out at read time, so an expired grant shows as ended.
create or replace function public.list_privilege_grants()
returns table ("grantId" text, "userId" text, "staffName" text, "email" text, "privilege" text, "reason" text,
               "expiresAt" timestamptz, "grantedAt" timestamptz, "grantedByName" text, "revokedAt" timestamptz,
               "active" boolean)
language plpgsql stable security definer set search_path = ''
as $$
begin
    if not public.is_super_admin(auth.uid()) then
        raise insufficient_privilege using message = 'Only a Super Admin can view temporary access';
    end if;
    return query
    select g."grantId"::text, g."userId"::text, concat_ws(' ', u."firstName", u."lastName"), u."email"::text,
           g."privilege"::text, g."reason"::text, g."expiresAt", g."grantedAt",
           concat_ws(' ', b."firstName", b."lastName"), g."revokedAt",
           g."revokedAt" is null and g."expiresAt" > now()
    from public."privilegeGrants" g
    join public."users" u on u."userId" = g."userId"
    join public."users" b on b."userId" = g."grantedBy"
    order by g."grantedAt" desc
    limit 100;
end;
$$;

revoke all on function public.has_active_grant(uuid, text), public.grant_privilege(bigint, text, timestamptz, text),
    public.revoke_privilege(bigint), public.list_privilege_grants(), public.has_content_admin_access(),
    public.can_manage_staff_accounts(uuid), public.get_admin_access(), public.link_provisioned_staff()
    from public, anon, authenticated, service_role;
grant execute on function public.grant_privilege(bigint, text, timestamptz, text), public.revoke_privilege(bigint),
    public.list_privilege_grants(), public.get_admin_access() to authenticated;
-- The file-storage rules for resource-files and content-images call this check as the signed-in
-- staff member, so uploads need it (it only answers about the caller's own access).
grant execute on function public.has_content_admin_access() to authenticated;
grant execute on function public.can_manage_staff_accounts(uuid) to service_role;

-- 4. WEBSITE CONTENT SEED --------------------------------------------------------
-- Copies the announcements and events the website shows today into "cmsContent" as published
-- items, so the content workspace can edit them. Skips any slug already present.
insert into public."cmsContent" ("contentType", "title", "slug", "summary", "body", "eventStartsAt", "status",
                                 "publishedAt", "createdBy", "updatedBy")
select v.kind, v.title, v.slug, v.summary, v.body, v.starts::timestamptz, 'published', null, s."userId", s."userId"
from (values
    ('announcement', 'School office transactions', 'office-transactions',
     'School office transactions are available Monday to Friday, from 8:00 AM to 5:00 PM.',
     E'The school welcomes office transactions from Monday to Friday, 8:00 AM to 5:00 PM.\n\nFor admissions and school records, contact the Registrar. For payment questions, contact the Finance Office.', null),
    ('announcement', 'GENYO learning platform for SY 2026–2027', 'genyo-learning-platform-2026-2027',
     'SNCS announces a GENYO 5G Systems learning-platform upgrade for the school community.',
     E'For school year 2026–2027, SNCS has announced an upgrade to the GENYO 5G Systems Learning Platform to support online distance learning.\n\nContact the school for information about learning-platform access and enrollment.', null),
    ('event', 'Wellness break: intermediate to high school', 'wellness-break', '', 'Published in the school’s September 2026 activity notices.', '2026-09-10 00:00:00+08'),
    ('event', 'Employees wellness break', 'employees-wellness-break', '', 'Published in the school’s September 2026 activity notices.', '2026-09-14 00:00:00+08'),
    ('event', 'Launching of CL, Science, and Math Week', 'cl-science-math-launch', '', 'Published in the school’s September 2026 activity notices.', '2026-09-21 00:00:00+08'),
    ('event', 'BSP and GSP investiture', 'bsp-gsp-investiture', '', 'Published in the school’s September 2026 activity notices.', '2026-09-25 00:00:00+08'),
    ('event', 'First Term Card Day and Parents’ Faith Formation', 'first-term-card-day', '', 'Published in the school’s September 2026 activity notices.', '2026-09-26 00:00:00+08'),
    ('event', 'Kainang Pamilya Mahalaga Day', 'kainang-pamilya', '', 'Published in the school’s September 2026 activity notices.', '2026-09-28 00:00:00+08'),
    ('event', 'Culminating of CL, Science, and Math Week', 'cl-science-math-culminating', '', 'Published in the school’s September 2026 activity notices.', '2026-09-28 00:00:00+08')
) as v(kind, title, slug, summary, body, starts)
cross join lateral (select "userId" from public."users" where "adminType" = 'superAdmin' order by "userId" limit 1) s
where not exists (select 1 from public."cmsContent" c where c."slug" = v.slug);

-- Check: privilege grants table exists and content is seeded.
select (select count(*) from public."privilegeGrants") as "privilegeGrants",
       (select count(*) from public."cmsContent") as "cmsContentItems";

commit;
