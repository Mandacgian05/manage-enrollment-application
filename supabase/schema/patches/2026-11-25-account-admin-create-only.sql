-- ============================================================================
-- SNCS TEST DATABASE (v12) patch, 2026-11-25: Account Admins only create accounts.
-- Changing roles, resetting passwords and deactivating accounts become Super Admin only.
-- Run once in the TEST project (sncs-test). Safe to run again. Changes no data.
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

revoke all on function public.is_super_admin(uuid), public.get_admin_access(), public.lock_staff_change(uuid, bigint),
    public.get_staff_auth_target(uuid, bigint) from public, anon, authenticated, service_role;
grant execute on function public.get_admin_access() to authenticated;
grant execute on function public.is_super_admin(uuid), public.get_staff_auth_target(uuid, bigint) to service_role;

commit;

select "email", "adminType",
       "adminType" in ('superAdmin', 'accountAdmin') as "createsAccounts",
       "adminType" = 'superAdmin' as "changesRolesResetsDeactivates"
from public."users" where "role" = 'admin' order by "userId";
