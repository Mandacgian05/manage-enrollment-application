-- ============================================================================
-- SNCS TEST DATABASE (v12) patch, 2026-11-25 (run once in sncs-test; safe to run again).
-- 1. Account Admins only create accounts. Changing roles, resetting passwords and
--    deactivating accounts are Super Admin only.
-- 2. Super Admin is never offered or granted from the website; set it in the database only
--    (Table Editor > users: role = admin, adminType = superAdmin).
-- Changes no data.
-- ============================================================================

begin;

create or replace function public.is_super_admin(p_user_id uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
    select (auth.uid() is null or (auth.uid() = p_user_id and public.has_live_staff_session())) and exists (
        select 1 from public."users"
        where "authUserId" = p_user_id and "role" = 'admin' and "status" = 'active'
          and "adminType" = 'superAdmin' and not "mustChangePassword"
    );
$$;

create or replace function public.get_admin_access()
returns jsonb language sql stable security definer set search_path = ''
as $$
    select jsonb_build_object('adminType', u."adminType",
        'manageAccounts', u."adminType" in ('superAdmin', 'accountAdmin'),
        'manageStaff', u."adminType" = 'superAdmin',
        'manageContent', u."adminType" in ('superAdmin', 'contentAdmin'))
    from public."users" u
    where u."authUserId" = auth.uid() and public.has_active_admin_access();
$$;

create or replace function public.lock_staff_change(p_actor_id uuid, p_staff_id bigint)
returns bigint language plpgsql security definer set search_path = ''
as $$
declare
    actor_id bigint;
begin
    perform 1 from public."users" where "authUserId" = p_actor_id or "userId" = p_staff_id
    order by "userId" for update;
    if not public.is_super_admin(p_actor_id) then
        raise insufficient_privilege using message = 'Only a Super Admin can change roles, reset passwords or deactivate accounts';
    end if;
    select "userId" into actor_id from public."users" where "authUserId" = p_actor_id;
    if actor_id = p_staff_id then
        raise insufficient_privilege using message = 'Cannot manage your own account';
    end if;
    return actor_id;
end;
$$;

create or replace function public.get_staff_auth_target(p_actor_id uuid, p_staff_id bigint)
returns uuid language sql stable security definer set search_path = ''
as $$
    select "authUserId" from public."users"
    where "userId" = p_staff_id and "status" = 'active'
      and "authUserId" <> p_actor_id and public.is_super_admin(p_actor_id);
$$;

create or replace function public.assign_staff_role(p_staff_id bigint, p_role text)
returns void language plpgsql security definer set search_path = ''
as $$
declare
    actor_id bigint := public.lock_staff_change(auth.uid(), p_staff_id);
    previous record;
    new_role text;
    new_type text;
begin
    if p_role is null or p_role not in ('accountAdmin', 'contentAdmin', 'registrar', 'teacher', 'academicCoordinator') then
        raise invalid_parameter_value using message = 'Unsupported staff role';
    end if;
    new_role := case when p_role in ('superAdmin', 'accountAdmin', 'contentAdmin') then 'admin' else p_role end;
    new_type := case when new_role = 'admin' then p_role end;
    select "role", "adminType" into previous from public."users" where "userId" = p_staff_id;
    if not found then
        raise no_data_found using message = 'Staff account no longer exists';
    end if;
    if previous."adminType" = 'superAdmin' then
        raise insufficient_privilege using message = 'Super Admin access is set in the database only';
    end if;
    if previous."role" = new_role and previous."adminType" is not distinct from new_type then
        return;
    end if;
    update public."users"
    set "role" = new_role, "adminType" = new_type, "updatedAt" = now()
    where "userId" = p_staff_id;
    insert into public."auditLogs" ("performedBy", "action", "entityType", "entityId", "oldValue", "newValue")
    values (actor_id, 'role.change', 'users', p_staff_id,
        jsonb_build_object('role', previous."role", 'adminType', previous."adminType"),
        jsonb_build_object('role', new_role, 'adminType', new_type));
end;
$$;

create or replace function public.link_provisioned_staff()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
    provisioning jsonb := new.raw_app_meta_data -> 'chimera_staff_provisioning';
    creator_type text;
    staff_role text;
begin
    if provisioning is null then
        return new;
    end if;
    if tg_op = 'UPDATE' and provisioning is not distinct from
        (old.raw_app_meta_data -> 'chimera_staff_provisioning') then
        return new;
    end if;

    select "adminType" into creator_type from public."users"
    where "authUserId" = (provisioning ->> 'createdBy')::uuid
      and "role" = 'admin' and "status" = 'active' and "adminType" in ('superAdmin', 'accountAdmin')
      and not "mustChangePassword"
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
            case when staff_role in ('superAdmin', 'accountAdmin', 'contentAdmin') then 'admin' else staff_role end,
            case when staff_role in ('superAdmin', 'accountAdmin', 'contentAdmin') then staff_role end, new.id);
    return new;
end;
$$;

revoke all on function public.is_super_admin(uuid), public.get_admin_access(), public.lock_staff_change(uuid, bigint),
    public.get_staff_auth_target(uuid, bigint), public.assign_staff_role(bigint, text), public.link_provisioned_staff()
    from public, anon, authenticated, service_role;
grant execute on function public.get_admin_access(), public.assign_staff_role(bigint, text) to authenticated;
grant execute on function public.is_super_admin(uuid), public.get_staff_auth_target(uuid, bigint) to service_role;

commit;

select "email", "adminType",
       "adminType" in ('superAdmin', 'accountAdmin') as "createsAccounts",
       "adminType" = 'superAdmin' as "changesRolesResetsDeactivates"
from public."users" where "role" = 'admin' order by "userId";
