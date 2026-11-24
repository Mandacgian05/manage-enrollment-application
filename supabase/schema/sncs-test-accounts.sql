-- ============================================================================
-- SNCS TEST DATABASE (v12) - test staff records and starter data
-- Run AFTER sncs-schema-v12.sql, in the TEST project only.
-- Uses the sign-ins in Authentication > Users:
--   superadmin1@gmail.com        Super Admin    (everything)
--   jansultan905@gmail.com       Account Admin  (Jan: staff accounts and roles)
--   tcorpuz@gmail.com            Content Admin  (Terrence: website content)
--   gsmandac@student.apc.edu.ph  Registrar      (Gian)
--   miles123@gmail.com           Academic Coordinator (Miles)
--   jbacani@gmail.com            Teacher        (create this sign-in too)
-- To change someone later: users.role is admin / registrar / teacher / academicCoordinator,
-- and for admins users.adminType is superAdmin / accountAdmin / contentAdmin.
-- ============================================================================

begin;

do $$
declare missing text;
begin
    select string_agg(e, ', ') into missing
    from unnest(array['superadmin1@gmail.com', 'jansultan905@gmail.com', 'tcorpuz@gmail.com',
                      'gsmandac@student.apc.edu.ph', 'miles123@gmail.com', 'jbacani@gmail.com']) e
    where not exists (select 1 from auth.users a where lower(a.email) = e);
    if missing is not null then
        raise exception 'Create these sign-ins in Authentication > Users first: %', missing;
    end if;
end $$;

insert into public."users" ("email", "firstName", "lastName", "role", "adminType", "authUserId")
select lower(a.email), t.first_name, t.last_name, t.role, t.admin_type, a.id
from (values
    ('superadmin1@gmail.com',       'Test',     'Super Admin', 'admin',               'superAdmin'),
    ('jansultan905@gmail.com',      'Jan',      'Sultan',      'admin',               'accountAdmin'),
    ('tcorpuz@gmail.com',           'Terrence', 'Corpuz',      'admin',               'contentAdmin'),
    ('gsmandac@student.apc.edu.ph', 'Gian',     'Mandac',      'registrar',           null),
    ('miles123@gmail.com',          'Miles',    'Gemillan',    'academicCoordinator', null),
    ('jbacani@gmail.com',           'J.',       'Bacani',      'teacher',             null)
) as t(email, first_name, last_name, role, admin_type)
join auth.users a on lower(a.email) = t.email
on conflict do nothing;

-- The Teacher's teaching profile (sample values; edit in Table Editor > teachers).
insert into public."teachers" ("userId", "employeeNumber", "department", "employmentStatus", "dateHired",
                               "highestDegree", "degreeMajor", "isLetLicensed", "licenseExpiryDate", "priorTeachingYears")
select "userId", 'T-0001', 'jhs', 'regular', date '2022-06-01', 'Bachelor of Secondary Education', 'Mathematics',
       true, date '2028-06-30', 3
from public."users" where "email" = 'jbacani@gmail.com'
on conflict do nothing;

-- The public enrollment form needs one open enrollment period.
insert into public."enrollmentPeriods" ("schoolYearStart", "schoolYearEnd", "openedBy", "openedAt")
select 2026, 2027, "userId", now() from public."users" where "email" = 'superadmin1@gmail.com'
on conflict do nothing;

commit;

select "email", "firstName", "role", "adminType", "authUserId" is not null as "linked" from public."users" order by "userId";
