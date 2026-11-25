-- ============================================================================
-- SNCS database, version 12 (ERD v12) - full structure for an EMPTY Supabase project
-- Team Chimera. Applies the adviser's database comments to every table:
--   1. Consistent names: <entity>Id keys; is/must booleans; *By who-columns;
--      *At timestamps; *Date dates.
--   2. Composite values split: person names (first/middle/last/suffix), addresses,
--      contact numbers, school years, section strands, days of the week.
--   3. camelCase tables and columns. Postgres folds unquoted names to lowercase,
--      so every table and column name is written in double quotes.
--   4. Checked data types: VARCHAR(n) for bounded text, CHAR(n) for fixed codes,
--      SMALLINT for small counts and ids, TIMESTAMPTZ for moments, DATE for days.
--   5. A fully defined teachers table.
-- Plus the ERD gap fixes: website content summary/images/trash, resource trash,
-- scheduleRuns.publishedBy, and three kinds of Admin in users.adminType:
--   superAdmin (everything), accountAdmin (creates staff accounts), contentAdmin (website content).
-- Function names keep their existing snake_case names so the website's calls are stable;
-- the data they return uses camelCase keys. Stored code values (statuses such as 'for_review',
-- departments such as 'grade_school') keep their existing lowercase codes; the Academic
-- Coordinator role is 'academicCoordinator', as listed in the ERD.
--
-- HOW TO USE: run in a NEW or RESET test project (SQL Editor > paste > Run).
-- It runs as one transaction and stops at once if SNCS tables already exist.
-- ============================================================================

begin;

do $$
begin
    if to_regclass('public.users') is not null or to_regclass('public."enrollmentApplications"') is not null then
        raise exception 'STOP: this project already has SNCS tables. Use a new project, or run the reset script in the TEST project first.';
    end if;
end $$;

-- ============================================================================
-- 1. ACCOUNTS AND ACCESS
-- ============================================================================

-- One row per staff member. Sign-in itself is Supabase Auth (auth.users).
create table public."users" (
    "userId"             bigint generated always as identity primary key,
    "authUserId"         uuid unique references auth.users(id) on delete set null,
    "email"              varchar(254) not null,
    "firstName"          varchar(100) not null,
    "middleName"         varchar(100),
    "lastName"           varchar(100) not null,
    "suffix"             varchar(10),
    "role"               varchar(20) not null check ("role" in ('admin', 'registrar', 'teacher', 'academicCoordinator')),
    "status"             varchar(10) not null default 'active' check ("status" in ('active', 'inactive')),
    "adminType"          varchar(20) check ("adminType" in ('superAdmin', 'accountAdmin', 'contentAdmin')),
    "mustChangePassword" boolean not null default false,   -- set by a temporary-password reset
    "createdAt"          timestamptz not null default now(),
    "updatedAt"          timestamptz not null default now(),
    check (("role" = 'admin') = ("adminType" is not null))   -- every Admin has exactly one admin type
);
create unique index "usersEmailUnique" on public."users" (lower("email"));

-- App-level session record so Deactivate Account can revoke access everywhere.
create table public."sessions" (
    "sessionId" uuid primary key default gen_random_uuid(),
    "userId"    bigint not null references public."users"("userId") on delete cascade,
    "tokenHash" char(64) not null unique,
    "createdAt" timestamptz not null default now(),
    "expiresAt" timestamptz not null,
    "revokedAt" timestamptz
);

create table public."auditLogs" (
    "auditLogId"  bigint generated always as identity primary key,
    "performedBy" bigint references public."users"("userId") on delete set null,
    "action"      varchar(60) not null,
    "entityType"  varchar(60) not null,
    "entityId"    bigint,
    "oldValue"    jsonb,
    "newValue"    jsonb,
    "createdAt"   timestamptz not null default now()
);

-- A Super Admin lends one privilege to another Admin until an end date, with a reason.
-- The grant stops working by itself at "expiresAt", or earlier when revoked.
create table public."privilegeGrants" (
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
create index "privilegeGrantsUserPrivilege" on public."privilegeGrants" ("userId", "privilege");

-- ============================================================================
-- 2. WEBSITE CONTENT
-- ============================================================================

create table public."cmsContent" (
    "contentId"     bigint generated always as identity primary key,
    "contentType"   varchar(20) not null check ("contentType" in ('announcement', 'event', 'page')),
    "title"         varchar(200) not null,
    "slug"          varchar(200) not null unique check ("slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
    "summary"       varchar(500) not null default '',
    "body"          text not null,
    "images"        jsonb not null default '[]'::jsonb
                    check (jsonb_typeof("images") = 'array' and jsonb_array_length("images") <= 4),
    "eventStartsAt" timestamptz,
    "status"        varchar(10) not null default 'draft' check ("status" in ('draft', 'published', 'archived')),
    "publishedAt"   timestamptz,
    "createdBy"     bigint not null references public."users"("userId"),
    "createdAt"     timestamptz not null default now(),
    "updatedBy"     bigint references public."users"("userId"),
    "updatedAt"     timestamptz not null default now(),
    "deletedAt"     timestamptz,                       -- set while the item is in the trash
    check ("contentType" <> 'event' or "eventStartsAt" is not null)
);

create table public."resources" (
    "resourceId"    bigint generated always as identity primary key,
    "title"         varchar(200) not null,
    "category"      varchar(60) not null,
    "storagePath"   text not null unique,
    "fileSizeBytes" integer not null check ("fileSizeBytes" between 1 and 10485760),
    "status"        varchar(10) not null default 'draft' check ("status" in ('draft', 'published', 'archived')),
    "visibility"    varchar(10) not null default 'private' check ("visibility" in ('public', 'private')),
    "uploadedBy"    bigint references public."users"("userId"),   -- null only for bootstrap imports
    "createdAt"     timestamptz not null default now(),
    "updatedAt"     timestamptz not null default now(),
    "deletedAt"     timestamptz
);

-- ============================================================================
-- 3. ENROLLMENT
-- ============================================================================

-- Reference list of grade levels; department and order come from here, not the application.
create table public."gradeLevels" (
    "gradeLevelId" smallint primary key,
    "name"         varchar(20) not null unique,
    "department"   varchar(20) not null check ("department" in ('preschool', 'grade_school', 'jhs', 'shs')),
    "sortOrder"    smallint not null unique
);
insert into public."gradeLevels" ("gradeLevelId", "name", "department", "sortOrder") values
    (1, 'Nursery', 'preschool', 1), (2, 'Kindergarten', 'preschool', 2),
    (3, 'Grade 1', 'grade_school', 3), (4, 'Grade 2', 'grade_school', 4), (5, 'Grade 3', 'grade_school', 5),
    (6, 'Grade 4', 'grade_school', 6), (7, 'Grade 5', 'grade_school', 7), (8, 'Grade 6', 'grade_school', 8),
    (9, 'Grade 7', 'jhs', 9), (10, 'Grade 8', 'jhs', 10), (11, 'Grade 9', 'jhs', 11),
    (12, 'Grade 10', 'jhs', 12), (13, 'Grade 11', 'shs', 13), (14, 'Grade 12', 'shs', 14);

-- A period is open while openedAt is set and closedAt is empty. At most one is open.
create table public."enrollmentPeriods" (
    "periodId"        bigint generated always as identity primary key,
    "schoolYearStart" smallint not null check ("schoolYearStart" between 2000 and 2100),
    "schoolYearEnd"   smallint not null,
    "openedBy"        bigint references public."users"("userId"),
    "openedAt"        timestamptz,
    "closedAt"        timestamptz,
    check ("schoolYearEnd" = "schoolYearStart" + 1),
    check ("closedAt" is null or "openedAt" is not null)
);
create unique index "enrollmentPeriodsOneOpen" on public."enrollmentPeriods" ((true))
    where "openedAt" is not null and "closedAt" is null;

create table public."enrollmentApplications" (
    "applicationId"              bigint generated always as identity primary key,
    "referenceNo"                varchar(40) not null unique,
    "periodId"                   bigint not null references public."enrollmentPeriods"("periodId"),
    "gradeLevelId"               smallint not null references public."gradeLevels"("gradeLevelId"),
    "applicantType"              varchar(10) not null check ("applicantType" in ('new', 'old', 'returnee')),
    "strandCode"                 varchar(20),           -- Grades 11-12 only
    "paymentMode"                varchar(15) not null check ("paymentMode" in ('full_cash', 'monthly', 'quarterly', 'semi_annual')),
    -- Student
    "lastName"                   varchar(100) not null,
    "firstName"                  varchar(100) not null,
    "middleName"                 varchar(100),
    "suffix"                     varchar(10),
    "birthDate"                  date not null,         -- age is computed, never stored
    "sex"                        varchar(6) not null check ("sex" in ('male', 'female')),
    "birthPlace"                 varchar(150) not null,
    "religion"                   varchar(100) not null,
    -- Address
    "houseStreet"                varchar(150) not null,
    "barangay"                   varchar(100) not null,
    "cityMunicipality"           varchar(100) not null,
    "province"                   varchar(100) not null,
    "zipCode"                    char(4) check ("zipCode" ~ '^[0-9]{4}$'),
    -- Contact
    "primaryContactNumber"       varchar(11) not null check ("primaryContactNumber" ~ '^09[0-9]{9}$'),
    "secondaryContactNumber"     varchar(11) check ("secondaryContactNumber" ~ '^09[0-9]{9}$'),
    "email"                      varchar(254) not null,
    "parentEmail"                varchar(254),
    -- Last school attended
    "lastSchoolName"             varchar(150),
    "lastSchoolCityMunicipality" varchar(100),
    "lastSchoolProvince"         varchar(100),
    -- Processing
    "status"                     varchar(12) not null default 'pending'
                                 check ("status" in ('pending', 'for_review', 'complete', 'incomplete')),
    "registrarRemarks"           varchar(1000),
    "privacyConsentAt"           timestamptz not null,  -- Data Privacy Act consent
    "submitterIpHash"            char(64) not null,     -- for the 5-per-hour limit
    "submittedAt"                timestamptz not null default now()
);

create table public."applicationGuardians" (
    "guardianId"       bigint generated always as identity primary key,
    "applicationId"    bigint not null references public."enrollmentApplications"("applicationId") on delete cascade,
    "relationship"     varchar(10) not null check ("relationship" in ('father', 'mother', 'guardian')),
    "lastName"         varchar(100) not null,
    "firstName"        varchar(100) not null,
    "middleName"       varchar(100),
    "suffix"           varchar(10),
    "occupation"       varchar(150),
    "contactNumber"    varchar(11) check ("contactNumber" ~ '^09[0-9]{9}$'),
    "email"            varchar(254),
    "messengerAccount" varchar(100),
    unique ("applicationId", "relationship")
);

-- Uploaded requirement files (uploads are deferred, SC-50; the table is ready).
create table public."applicationDocuments" (
    "documentId"     bigint generated always as identity primary key,
    "applicationId"  bigint not null references public."enrollmentApplications"("applicationId") on delete cascade,
    "requirementKey" varchar(60) not null,
    "storagePath"    text not null unique,
    "contentType"    varchar(20) not null check ("contentType" in ('application/pdf', 'image/jpeg', 'image/png')),
    "fileSizeBytes"  integer not null check ("fileSizeBytes" between 1 and 10485760),
    "uploadedAt"     timestamptz not null default now()
);

-- Registrar's checklist: one row per requirement marked received or not received.
create table public."applicationRequirementChecks" (
    "applicationId"  bigint not null references public."enrollmentApplications"("applicationId") on delete cascade,
    "requirementKey" varchar(60) not null check ("requirementKey" ~ '^[a-z0-9-]{1,60}$'),
    "isReceived"     boolean not null,
    "checkedBy"      bigint references public."users"("userId") on delete set null,
    "checkedAt"      timestamptz not null default now(),
    primary key ("applicationId", "requirementKey")
);

-- ============================================================================
-- 4. SCHEDULING
-- ============================================================================

create table public."terms" (
    "termId"          smallint generated always as identity primary key,
    "schoolYearStart" smallint not null check ("schoolYearStart" between 2000 and 2100),
    "schoolYearEnd"   smallint not null,
    "name"            varchar(50) not null,      -- 'Term 2'
    "isActive"        boolean not null default false,
    check ("schoolYearEnd" = "schoolYearStart" + 1),
    unique ("schoolYearStart", "name")
);
create unique index "termsOneActive" on public."terms" ((true)) where "isActive";

-- Every teacher is a staff member (users); this holds the teaching profile.
create table public."teachers" (
    "teacherId"          bigint generated always as identity primary key,
    "userId"             bigint not null unique references public."users"("userId") on delete cascade,
    "employeeNumber"     varchar(20) not null unique,
    "department"         varchar(20) not null check ("department" in ('preschool', 'grade_school', 'jhs', 'shs')),
    "employmentStatus"   varchar(20) not null check ("employmentStatus" in ('regular', 'probationary', 'contractual', 'part_time')),
    "dateHired"          date not null,
    "highestDegree"      varchar(100) not null,
    "degreeMajor"        varchar(100) not null,
    "isLetLicensed"      boolean not null default false,   -- passed the Licensure Examination for Teachers
    "licenseExpiryDate"  date,
    "priorTeachingYears" smallint not null default 0 check ("priorTeachingYears" between 0 and 60),
    "loadLimitMinutes"   smallint not null default 1500 check ("loadLimitMinutes" between 0 and 3000),
    check ("isLetLicensed" or "licenseExpiryDate" is null)
);

create table public."subjectAreas" (
    "subjectAreaId" smallint generated always as identity primary key,
    "name"          varchar(60) not null unique      -- 'Mathematics', 'Filipino'
);

create table public."teacherSpecializations" (
    "teacherId"     bigint not null references public."teachers"("teacherId") on delete cascade,
    "subjectAreaId" smallint not null references public."subjectAreas"("subjectAreaId") on delete cascade,
    "isPrimary"     boolean not null default false,
    primary key ("teacherId", "subjectAreaId")
);
create unique index "teacherSpecializationsOnePrimary" on public."teacherSpecializations" ("teacherId") where "isPrimary";

create table public."rooms" (
    "roomId"     smallint generated always as identity primary key,
    "roomNumber" varchar(20) not null unique,
    "roomName"   varchar(60) not null,
    "roomType"   varchar(20) not null default 'classroom' check ("roomType" in ('classroom', 'laboratory', 'computer_lab', 'gym', 'library', 'other')),
    "isActive"   boolean not null default true
);

create table public."subjects" (
    "subjectId"        bigint generated always as identity primary key,
    "name"             varchar(100) not null unique,   -- 'Filipino 7'
    "gradeLevelId"     smallint references public."gradeLevels"("gradeLevelId"),   -- null = any grade
    "subjectAreaId"    smallint not null references public."subjectAreas"("subjectAreaId"),
    "subjectType"      varchar(10) not null check ("subjectType" in ('core', 'strand', 'homeroom')),
    "requiredRoomType" varchar(20) check ("requiredRoomType" in ('classroom', 'laboratory', 'computer_lab', 'gym', 'library', 'other'))
);

create table public."sections" (
    "sectionId"        bigint generated always as identity primary key,
    "termId"           smallint not null references public."terms"("termId"),
    "gradeLevelId"     smallint not null references public."gradeLevels"("gradeLevelId"),
    "name"             varchar(100) not null,         -- 'G7 - Our Lady of Guadalupe'
    "adviserTeacherId" bigint references public."teachers"("teacherId") on delete set null,
    "homeRoomId"       smallint references public."rooms"("roomId") on delete set null,
    unique ("termId", "name")
);

-- One row per strand offered in a section ('ABM' and 'ICT' for a combined class).
create table public."sectionStrands" (
    "sectionId"  bigint not null references public."sections"("sectionId") on delete cascade,
    "strandCode" varchar(20) not null,
    primary key ("sectionId", "strandCode")
);

create table public."teacherUnavailability" (
    "unavailabilityId" bigint generated always as identity primary key,
    "termId"           smallint not null references public."terms"("termId"),
    "teacherId"        bigint not null references public."teachers"("teacherId") on delete cascade,
    "dayOfWeek"        smallint not null check ("dayOfWeek" between 1 and 6),   -- 1 = Monday
    "startTime"        time not null,
    "endTime"          time not null,
    "reason"           varchar(200),
    check ("endTime" > "startTime")
);

-- Bell schedule: one row per day, so 'Mon-Thu' is stored as four rows.
create table public."timeSlots" (
    "timeSlotId"  bigint generated always as identity primary key,
    "termId"      smallint not null references public."terms"("termId"),
    "recessGroup" varchar(5) not null check ("recessGroup" in ('7-8', '9-10', '11-12')),
    "dayOfWeek"   smallint not null check ("dayOfWeek" between 1 and 6),
    "slotOrder"   smallint not null,
    "slotType"    varchar(10) not null check ("slotType" in ('class', 'recess', 'lunch')),
    "startTime"   time not null,
    "endTime"     time not null,
    check ("endTime" > "startTime"),
    unique ("termId", "recessGroup", "dayOfWeek", "slotOrder")
);

-- Teaching load from the Excel upload: one teacher + subject + section (+ strand for split classes).
create table public."teacherLoads" (
    "teacherLoadId"     bigint generated always as identity primary key,
    "teacherId"         bigint not null references public."teachers"("teacherId"),
    "subjectId"         bigint not null references public."subjects"("subjectId"),
    "sectionId"         bigint not null references public."sections"("sectionId") on delete cascade,
    "strandCode"        varchar(20),
    "meetings60PerWeek" smallint not null default 0 check ("meetings60PerWeek" between 0 and 10),
    "meetings45PerWeek" smallint not null default 0 check ("meetings45PerWeek" between 0 and 10),
    check ("meetings60PerWeek" + "meetings45PerWeek" > 0),
    unique nulls not distinct ("subjectId", "sectionId", "strandCode")   -- one teacher per class
);

create table public."scheduleRuns" (
    "runId"        bigint generated always as identity primary key,
    "termId"       smallint not null references public."terms"("termId"),
    "status"       varchar(12) not null default 'draft' check ("status" in ('draft', 'published', 'superseded', 'failed')),
    "solverResult" varchar(20) check ("solverResult" in ('optimal', 'feasible', 'infeasible', 'unknown')),
    "unresolved"   jsonb,                               -- classes the solver could not place
    "generatedBy"  bigint not null references public."users"("userId"),
    "generatedAt"  timestamptz not null default now(),
    "publishedBy"  bigint references public."users"("userId"),
    "publishedAt"  timestamptz,
    check (("status" = 'published') = ("publishedAt" is not null) or "status" = 'superseded')
);
create unique index "scheduleRunsOnePublished" on public."scheduleRuns" ("termId") where "status" = 'published';

create table public."scheduleEntries" (
    "entryId"       bigint generated always as identity primary key,
    "runId"         bigint not null references public."scheduleRuns"("runId") on delete cascade,
    "teacherLoadId" bigint not null references public."teacherLoads"("teacherLoadId") on delete cascade,
    "timeSlotId"    bigint not null references public."timeSlots"("timeSlotId"),
    "roomId"        smallint references public."rooms"("roomId"),
    "isFixed"       boolean not null default false,     -- kept in place when regenerating
    unique ("runId", "teacherLoadId", "timeSlotId"),
    unique ("runId", "roomId", "timeSlotId")
);

-- A teacher can't be in two overlapping class meetings in the same run.
create function public.prevent_teacher_double_booking()
returns trigger language plpgsql set search_path = ''
as $$
begin
    if exists (
        select 1
        from public."scheduleEntries" e
        join public."teacherLoads" l on l."teacherLoadId" = e."teacherLoadId"
        join public."timeSlots" s on s."timeSlotId" = e."timeSlotId"
        join public."teacherLoads" nl on nl."teacherLoadId" = new."teacherLoadId"
        join public."timeSlots" ns on ns."timeSlotId" = new."timeSlotId"
        where e."runId" = new."runId" and e."entryId" <> coalesce(new."entryId", -1)
          and l."teacherId" = nl."teacherId" and s."dayOfWeek" = ns."dayOfWeek"
          and s."startTime" < ns."endTime" and ns."startTime" < s."endTime"
    ) then
        raise exclusion_violation using message = 'This teacher already has a class at that time';
    end if;
    return new;
end;
$$;
create trigger "scheduleEntriesNoTeacherDoubleBooking"
before insert or update on public."scheduleEntries"
for each row execute function public.prevent_teacher_double_booking();

-- ============================================================================
-- 5. ROW LEVEL SECURITY: on for every table; browsers get no direct table access
--    except the public read rules below. Staff use the functions in section 6.
-- ============================================================================
do $$
declare t text;
begin
    for t in select tablename from pg_tables where schemaname = 'public' loop
        execute format('alter table public.%I enable row level security', t);
        execute format('revoke all on public.%I from public, anon, authenticated', t);
    end loop;
end $$;

-- Visitors read published website content that is not in the trash.
grant select ("contentId", "contentType", "title", "slug", "summary", "body", "images", "eventStartsAt", "publishedAt", "updatedAt")
    on public."cmsContent" to anon, authenticated;
create policy "Read published website content" on public."cmsContent" for select to anon, authenticated
    using ("status" = 'published' and "deletedAt" is null);

-- Visitors read published public PDFs that are not in the trash.
grant select ("resourceId", "title", "category", "storagePath", "fileSizeBytes", "status", "visibility")
    on public."resources" to anon, authenticated;
create policy "Read public published resources" on public."resources" for select to anon, authenticated
    using ("status" = 'published' and "visibility" = 'public' and "deletedAt" is null);

-- ============================================================================
-- 6. FUNCTIONS
-- ============================================================================

-- Access checks START
-- True while the given sign-in holds an unexpired, unrevoked grant and is an active Admin.
create function public.has_active_grant(p_user_id uuid, p_privilege text)
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

-- A revoked Auth session must lose portal access even before its token expires.
create function public.has_live_staff_session()
returns boolean language sql stable security definer set search_path = ''
as $$
    select exists (
        select 1 from auth.sessions
        where id = nullif(auth.jwt() ->> 'session_id', '')::uuid and user_id = auth.uid()
    );
$$;

-- The signed-in staff member's role, or 'password-change' while a temporary password is in use.
create function public.get_staff_portal_role()
returns text language sql stable security definer set search_path = ''
as $$
    select case when "mustChangePassword" then 'password-change' else "role" end
    from public."users"
    where "authUserId" = auth.uid() and "status" = 'active' and public.has_live_staff_session();
$$;

create function public.has_active_admin_access()
returns boolean language sql stable security definer set search_path = ''
as $$
    select coalesce(public.get_staff_portal_role() = 'admin', false);
$$;

-- Website content: Super Admins, Content Admins, and Admins with an active manageContent grant.
create function public.has_content_admin_access()
returns boolean language sql stable security definer set search_path = ''
as $$
    select public.has_active_admin_access() and (
        exists (select 1 from public."users" where "authUserId" = auth.uid() and "adminType" in ('superAdmin', 'contentAdmin'))
        or public.has_active_grant(auth.uid(), 'manageContent'));
$$;

-- Staff accounts: Super Admins, Account Admins, and Admins with an active manageStaffAccounts grant.
-- With no signed-in user (server key) it checks the given account only.
create function public.can_manage_staff_accounts(p_user_id uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
    select (auth.uid() is null or (auth.uid() = p_user_id and public.has_live_staff_session())) and exists (
        select 1 from public."users"
        where "authUserId" = p_user_id and "role" = 'admin' and "status" = 'active' and not "mustChangePassword"
          and ("adminType" in ('superAdmin', 'accountAdmin') or public.has_active_grant(p_user_id, 'manageStaffAccounts'))
    );
$$;

-- Changing roles, resetting passwords and deactivating accounts: Super Admins only.
-- With no signed-in user (server key) it checks the given account only.
create function public.is_super_admin(p_user_id uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
    select (auth.uid() is null or (auth.uid() = p_user_id and public.has_live_staff_session())) and exists (
        select 1 from public."users"
        where "authUserId" = p_user_id and "role" = 'admin' and "status" = 'active'
          and "adminType" = 'superAdmin' and not "mustChangePassword"
    );
$$;

-- What the signed-in Admin may open, for the dashboard's side panel.
-- manageAccounts: see the staff list and create accounts (Super Admin, Account Admin, or a grant).
-- temporaryAccess: active grants with their end dates.
-- manageStaff: change roles, reset passwords, deactivate (Super Admin only).
create function public.get_admin_access()
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

create function public.require_registrar()
returns bigint language plpgsql stable security definer set search_path = ''
as $$
declare
    actor_id bigint;
begin
    if public.get_staff_portal_role() is distinct from 'registrar' then
        raise insufficient_privilege using message = 'Registrar access required';
    end if;
    select "userId" into actor_id from public."users" where "authUserId" = auth.uid();
    return actor_id;
end;
$$;

-- Website content changes: Super Admins and Content Admins.
create function public.require_admin()
returns bigint language plpgsql stable security definer set search_path = ''
as $$
declare
    actor_id bigint;
begin
    if not public.has_content_admin_access() then
        raise insufficient_privilege using message = 'Content Admin access required';
    end if;
    select "userId" into actor_id from public."users" where "authUserId" = auth.uid();
    return actor_id;
end;
$$;
-- Access checks END

-- Manage Accounts START
create function public.list_staff_accounts(p_offset integer default 0)
returns table ("userId" text, "firstName" text, "middleName" text, "lastName" text, "suffix" text,
               "email" text, "role" text, "adminType" text, "status" text)
language plpgsql stable security definer set search_path = ''
as $$
begin
    if not public.can_manage_staff_accounts(auth.uid()) then
        raise insufficient_privilege using message = 'Staff account management access required';
    end if;
    return query select u."userId"::text, u."firstName"::text, u."middleName"::text, u."lastName"::text, u."suffix"::text,
        u."email"::text, u."role"::text, u."adminType"::text, u."status"::text
    from public."users" u order by u."userId" desc limit 26 offset greatest(p_offset, 0);
end;
$$;

-- Lock actor and target in a consistent order through a role change, password reset or
-- deactivation. Only a Super Admin may make these changes; Account Admins only create accounts.
create function public.lock_staff_change(p_actor_id uuid, p_staff_id bigint)
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

-- Assign User Roles (Super Admin only). p_role is one of the five roles offered in Account
-- management: accountAdmin, contentAdmin (stored as role 'admin' + adminType), registrar,
-- teacher, academicCoordinator. Super Admin access is never granted or removed from the
-- website; it is set in the database only. A role is also chosen when an account is created.
create function public.assign_staff_role(p_staff_id bigint, p_role text)
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

-- Create Account: Auth writes admin-only app metadata when the server provisions the login.
-- The staff row is created in that same transaction, so a failed insert rolls back both.
create function public.link_provisioned_staff()
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
create trigger chimera_link_provisioned_staff
after insert or update of raw_app_meta_data on auth.users
for each row execute function public.link_provisioned_staff();

create function public.audit_staff_creation()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
    insert into public."auditLogs" ("performedBy", "action", "entityType", "entityId", "newValue")
    select (select "userId" from public."users" where "authUserId" =
               (u.raw_app_meta_data -> 'chimera_staff_provisioning' ->> 'createdBy')::uuid),
           'account.create', 'users', new."userId", jsonb_build_object('role', new."role", 'adminType', new."adminType")
    from auth.users u
    where u.id = new."authUserId" and u.raw_app_meta_data ? 'chimera_staff_provisioning';
    return new;
end;
$$;
create trigger chimera_audit_staff_creation
after insert on public."users" for each row execute function public.audit_staff_creation();

-- Reset Password and Deactivate Account
create function public.get_staff_auth_target(p_actor_id uuid, p_staff_id bigint)
returns uuid language sql stable security definer set search_path = ''
as $$
    select "authUserId" from public."users"
    where "userId" = p_staff_id and "status" = 'active'
      and "authUserId" <> p_actor_id and public.is_super_admin(p_actor_id);
$$;

create function public.sync_staff_auth_action()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
    staff_action jsonb := new.raw_app_meta_data -> 'chimera_staff_action';
    previous_action jsonb := old.raw_app_meta_data -> 'chimera_staff_action';
    staff_id bigint;
    actor_id bigint;
begin
    if staff_action is null or staff_action is not distinct from previous_action then
        return new;
    end if;

    -- Change Temporary Password: Auth updates the password, sessions and metadata together.
    if staff_action ->> 'action' = 'complete-password-change' then
        if (previous_action ->> 'action') is distinct from 'reset-password'
            or (previous_action ->> 'request_id') is distinct from (staff_action ->> 'reset_id') then
            raise insufficient_privilege using message = 'The password reset has changed';
        end if;
        update public."users" set "mustChangePassword" = false, "updatedAt" = now()
        where "authUserId" = new.id and "status" = 'active' and "mustChangePassword";
        if not found then
            raise insufficient_privilege using message = 'Password change is unavailable';
        end if;
        return new;
    end if;

    staff_id := (staff_action ->> 'staff_id')::bigint;
    actor_id := public.lock_staff_change((staff_action ->> 'actor_id')::uuid, staff_id);
    perform 1 from public."users" where "userId" = staff_id and "authUserId" = new.id and "status" = 'active';
    if not found then
        raise insufficient_privilege using message = 'Staff account target is unavailable';
    end if;
    case staff_action ->> 'action'
      when 'reset-password' then
        update public."users" set "mustChangePassword" = true, "updatedAt" = now() where "userId" = staff_id;
        insert into public."auditLogs" ("performedBy", "action", "entityType", "entityId")
        values (actor_id, 'account.password_reset', 'users', staff_id);
      when 'deactivate' then
        update public."users" set "status" = 'inactive', "updatedAt" = now() where "userId" = staff_id;
        insert into public."auditLogs" ("performedBy", "action", "entityType", "entityId", "oldValue", "newValue")
        values (actor_id, 'account.deactivate', 'users', staff_id,
            '{"status":"active"}'::jsonb, '{"status":"inactive"}'::jsonb);
      else
        raise invalid_parameter_value using message = 'Unsupported staff account action';
    end case;
    update public."sessions" set "revokedAt" = now() where "userId" = staff_id and "revokedAt" is null;
    return new;
end;
$$;
create trigger chimera_sync_staff_auth_action
after update of raw_app_meta_data on auth.users
for each row execute function public.sync_staff_auth_action();
-- Manage Accounts END

-- Manage Enrollment Application START
-- Search and Filter Application
create function public.search_registrar_applications(
    p_query text default null,
    p_status text default null,
    p_from date default null,
    p_to date default null,
    p_offset integer default 0
)
returns table ("referenceNo" text, "firstName" text, "middleName" text, "lastName" text, "suffix" text,
               "gradeLevel" text, "status" text, "submittedAt" timestamptz)
language plpgsql stable security definer set search_path = ''
as $$
declare
    q text := lower(btrim(coalesce(p_query, '')));
begin
    perform public.require_registrar();
    if p_status is not null and p_status not in ('pending', 'for_review', 'complete', 'incomplete') then
        raise invalid_parameter_value using message = 'Unknown application status';
    end if;
    if length(q) > 100 then
        raise invalid_parameter_value using message = 'Search text is too long';
    end if;

    -- position() matches literally, so % and _ in the search text are not wildcards.
    return query
    select a."referenceNo"::text, a."firstName"::text, a."middleName"::text, a."lastName"::text, a."suffix"::text,
           g."name"::text, a."status"::text, a."submittedAt"
    from public."enrollmentApplications" a
    join public."gradeLevels" g on g."gradeLevelId" = a."gradeLevelId"
    where (q = '' or position(q in lower(a."referenceNo")) > 0
           or position(q in lower(a."firstName" || ' ' || coalesce(a."middleName" || ' ', '') || a."lastName")) > 0
           or position(q in lower(a."lastName" || ', ' || a."firstName")) > 0)
      and (p_status is null or a."status" = p_status)
      and (p_from is null or (a."submittedAt" at time zone 'Asia/Manila')::date >= p_from)
      and (p_to is null or (a."submittedAt" at time zone 'Asia/Manila')::date <= p_to)
    order by a."submittedAt" desc, a."applicationId" desc
    limit 26 offset greatest(p_offset, 0);
end;
$$;

-- Review Application Details & Documents. Returns null for an unknown reference.
create function public.get_registrar_application(p_reference text)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
    result jsonb;
begin
    perform public.require_registrar();
    select (to_jsonb(a) - 'submitterIpHash' - 'periodId' - 'gradeLevelId') || jsonb_build_object(
        'schoolYearStart', p."schoolYearStart",
        'schoolYearEnd', p."schoolYearEnd",
        'gradeLevel', g."name",
        'department', g."department",
        'guardians', coalesce((select jsonb_agg(to_jsonb(gu) - 'guardianId' - 'applicationId' order by gu."relationship")
            from public."applicationGuardians" gu where gu."applicationId" = a."applicationId"), '[]'::jsonb),
        'documents', coalesce((select jsonb_agg(jsonb_build_object(
                'documentId', d."documentId", 'requirementKey', d."requirementKey",
                'contentType', d."contentType", 'uploadedAt', d."uploadedAt") order by d."uploadedAt")
            from public."applicationDocuments" d where d."applicationId" = a."applicationId"), '[]'::jsonb),
        'requirementChecks', coalesce((select jsonb_object_agg(c."requirementKey", c."isReceived")
            from public."applicationRequirementChecks" c where c."applicationId" = a."applicationId"), '{}'::jsonb))
    into result
    from public."enrollmentApplications" a
    join public."enrollmentPeriods" p on p."periodId" = a."periodId"
    join public."gradeLevels" g on g."gradeLevelId" = a."gradeLevelId"
    where a."referenceNo" = p_reference;
    return result;
end;
$$;

-- Verify Requirement Checklist
create function public.set_application_requirement(p_reference text, p_requirement text, p_received boolean)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
    actor_id bigint := public.require_registrar();
    app_id bigint;
    previous boolean;
begin
    if p_requirement is null or p_requirement !~ '^[a-z0-9-]{1,60}$' or p_received is null then
        raise invalid_parameter_value using message = 'Invalid requirement';
    end if;
    select "applicationId" into app_id from public."enrollmentApplications" where "referenceNo" = p_reference for update;
    if app_id is null then
        raise no_data_found using message = 'Application not found';
    end if;
    select "isReceived" into previous from public."applicationRequirementChecks"
    where "applicationId" = app_id and "requirementKey" = p_requirement;

    insert into public."applicationRequirementChecks" ("applicationId", "requirementKey", "isReceived", "checkedBy", "checkedAt")
    values (app_id, p_requirement, p_received, actor_id, now())
    on conflict ("applicationId", "requirementKey")
    do update set "isReceived" = excluded."isReceived", "checkedBy" = excluded."checkedBy", "checkedAt" = excluded."checkedAt";

    insert into public."auditLogs" ("performedBy", "action", "entityType", "entityId", "oldValue", "newValue")
    values (actor_id, 'application.requirement_check', 'enrollmentApplications', app_id,
            case when previous is null then null else jsonb_build_object('requirementKey', p_requirement, 'isReceived', previous) end,
            jsonb_build_object('requirementKey', p_requirement, 'isReceived', p_received));
end;
$$;

-- Update Application Status & Registrar Remarks. Pending is the submission state only.
create function public.update_application_status(p_reference text, p_status text, p_remarks text default null)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
    actor_id bigint := public.require_registrar();
    app public."enrollmentApplications"%rowtype;
    remarks text := nullif(btrim(coalesce(p_remarks, '')), '');
begin
    if p_status is null or p_status not in ('for_review', 'complete', 'incomplete') then
        raise invalid_parameter_value using message = 'Choose For Review, Complete or Incomplete';
    end if;
    if length(remarks) > 1000 then
        raise invalid_parameter_value using message = 'Remarks must be 1,000 characters or fewer';
    end if;
    select * into app from public."enrollmentApplications" where "referenceNo" = p_reference for update;
    if app."applicationId" is null then
        raise no_data_found using message = 'Application not found';
    end if;
    if app."status" = p_status and app."registrarRemarks" is not distinct from remarks then
        return jsonb_build_object('status', app."status", 'registrarRemarks', app."registrarRemarks", 'changed', false);
    end if;

    update public."enrollmentApplications"
    set "status" = p_status, "registrarRemarks" = remarks
    where "applicationId" = app."applicationId";

    insert into public."auditLogs" ("performedBy", "action", "entityType", "entityId", "oldValue", "newValue")
    values (actor_id, 'application.status_change', 'enrollmentApplications', app."applicationId",
            jsonb_build_object('status', app."status", 'registrarRemarks', app."registrarRemarks"),
            jsonb_build_object('status', p_status, 'registrarRemarks', remarks));

    return jsonb_build_object('status', p_status, 'registrarRemarks', remarks, 'changed', true);
end;
$$;

-- Preview & Send Status Email: the edge function records each send with the Registrar's session.
create function public.record_status_email(p_reference text, p_status text, p_sent boolean)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
    actor_id bigint := public.require_registrar();
    app_id bigint;
begin
    select "applicationId" into app_id from public."enrollmentApplications" where "referenceNo" = p_reference;
    if app_id is null then
        raise no_data_found using message = 'Application not found';
    end if;
    insert into public."auditLogs" ("performedBy", "action", "entityType", "entityId", "newValue")
    values (actor_id, case when p_sent then 'application.status_email' else 'application.status_email_failed' end,
            'enrollmentApplications', app_id, jsonb_build_object('status', p_status));
end;
$$;
-- Manage Enrollment Application END

-- View Class Schedule (Teacher) START
-- A signed-in Teacher sees only their own meetings from the published run.
create function public.get_teacher_schedule()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
    teacher_id bigint;
    teacher_name text;
    run record;
begin
    if public.get_staff_portal_role() is distinct from 'teacher' then
        raise insufficient_privilege using message = 'Teacher access required';
    end if;

    select t."teacherId", concat_ws(' ', u."firstName", u."middleName", u."lastName", u."suffix")
    into teacher_id, teacher_name
    from public."teachers" t
    join public."users" u on u."userId" = t."userId"
    where u."authUserId" = auth.uid();

    if teacher_id is null then
        return jsonb_build_object('linked', false, 'run', null, 'entries', '[]'::jsonb);
    end if;

    -- The active term's published run; otherwise the most recently published run.
    select r."runId", r."publishedAt", tm."schoolYearStart", tm."schoolYearEnd", tm."name" as term_name into run
    from public."scheduleRuns" r
    join public."terms" tm on tm."termId" = r."termId"
    where r."status" = 'published'
    order by tm."isActive" desc, r."publishedAt" desc nulls last, r."runId" desc
    limit 1;

    if not found then
        return jsonb_build_object('linked', true, 'teacherName', teacher_name, 'run', null, 'entries', '[]'::jsonb);
    end if;

    return jsonb_build_object(
        'linked', true,
        'teacherName', teacher_name,
        'run', jsonb_build_object('schoolYearStart', run."schoolYearStart", 'schoolYearEnd', run."schoolYearEnd",
                                  'term', run.term_name, 'publishedAt', run."publishedAt"),
        'entries', coalesce((
            select jsonb_agg(jsonb_build_object(
                    'dayOfWeek', ts."dayOfWeek",
                    'startTime', to_char(ts."startTime", 'HH24:MI'),
                    'endTime', to_char(ts."endTime", 'HH24:MI'),
                    'subject', s."name",
                    'section', sc."name",
                    'gradeLevel', g."name",
                    'strands', coalesce(l."strandCode",
                        (select string_agg(ss."strandCode", ', ' order by ss."strandCode")
                         from public."sectionStrands" ss where ss."sectionId" = sc."sectionId")),
                    'room', rm."roomName",
                    'isFixed', e."isFixed")
                order by ts."dayOfWeek", ts."startTime", s."name")
            from public."scheduleEntries" e
            join public."timeSlots" ts on ts."timeSlotId" = e."timeSlotId"
            join public."teacherLoads" l on l."teacherLoadId" = e."teacherLoadId"
            join public."subjects" s on s."subjectId" = l."subjectId"
            join public."sections" sc on sc."sectionId" = l."sectionId"
            join public."gradeLevels" g on g."gradeLevelId" = sc."gradeLevelId"
            left join public."rooms" rm on rm."roomId" = e."roomId"
            where e."runId" = run."runId" and l."teacherId" = teacher_id), '[]'::jsonb));
end;
$$;
-- View Class Schedule (Teacher) END

-- Manage Website Content START
create function public.cms_list_content()
returns table ("contentId" bigint, "contentType" text, "title" text, "slug" text, "summary" text, "body" text,
               "images" jsonb, "eventStartsAt" timestamptz, "status" text, "publishedAt" timestamptz,
               "updatedAt" timestamptz, "deletedAt" timestamptz, "createdByName" text, "updatedByName" text)
language plpgsql stable security definer set search_path = ''
as $$
begin
    perform public.require_admin();
    return query
    select c."contentId", c."contentType"::text, c."title"::text, c."slug"::text, c."summary"::text, c."body",
           c."images", c."eventStartsAt", c."status"::text, c."publishedAt", c."updatedAt", c."deletedAt",
           concat_ws(' ', cu."firstName", cu."lastName"), concat_ws(' ', uu."firstName", uu."lastName")
    from public."cmsContent" c
    left join public."users" cu on cu."userId" = c."createdBy"
    left join public."users" uu on uu."userId" = c."updatedBy"
    order by c."updatedAt" desc;
end;
$$;

-- p_id null creates a draft; otherwise updates an existing item's text (status unchanged).
create function public.cms_save_content(
    p_id bigint, p_type text, p_title text, p_slug text, p_summary text, p_body text,
    p_event_starts_at timestamptz default null, p_images jsonb default '[]'::jsonb
)
returns bigint language plpgsql security definer set search_path = ''
as $$
declare
    actor_id bigint := public.require_admin();
    previous jsonb;
    saved_id bigint;
begin
    if p_type not in ('announcement', 'event', 'page') then
        raise invalid_parameter_value using message = 'Unknown content type';
    end if;
    if length(btrim(coalesce(p_title, ''))) = 0 or length(p_title) > 200 then
        raise invalid_parameter_value using message = 'Title must be 1 to 200 characters';
    end if;
    if length(coalesce(p_body, '')) > 50000 or length(coalesce(p_summary, '')) > 500 then
        raise invalid_parameter_value using message = 'Text is too long';
    end if;

    if p_id is null then
        insert into public."cmsContent" ("contentType", "title", "slug", "summary", "body", "eventStartsAt", "images",
                                         "createdBy", "updatedBy")
        values (p_type, btrim(p_title), p_slug, coalesce(p_summary, ''), coalesce(p_body, ''), p_event_starts_at,
                coalesce(p_images, '[]'::jsonb), actor_id, actor_id)
        returning "contentId" into saved_id;
    else
        select to_jsonb(c) - 'body' into previous from public."cmsContent" c where c."contentId" = p_id and c."deletedAt" is null;
        if previous is null then
            raise no_data_found using message = 'Content not found';
        end if;
        update public."cmsContent"
        set "contentType" = p_type, "title" = btrim(p_title), "slug" = p_slug, "summary" = coalesce(p_summary, ''),
            "body" = coalesce(p_body, ''), "eventStartsAt" = p_event_starts_at, "images" = coalesce(p_images, '[]'::jsonb),
            "updatedBy" = actor_id, "updatedAt" = now()
        where "contentId" = p_id
        returning "contentId" into saved_id;
    end if;

    insert into public."auditLogs" ("performedBy", "action", "entityType", "entityId", "oldValue", "newValue")
    values (actor_id, case when p_id is null then 'cms.create' else 'cms.update' end, 'cmsContent', saved_id,
            previous, jsonb_build_object('contentType', p_type, 'title', btrim(p_title), 'slug', p_slug));
    return saved_id;
end;
$$;
-- Manage Website Content END

-- Manage Downloadable Resources START
create function public.cms_list_resources()
returns table ("resourceId" bigint, "title" text, "category" text, "storagePath" text, "fileSizeBytes" integer,
               "status" text, "visibility" text, "updatedAt" timestamptz, "deletedAt" timestamptz, "uploadedByName" text)
language plpgsql stable security definer set search_path = ''
as $$
begin
    perform public.require_admin();
    return query
    select r."resourceId", r."title"::text, r."category"::text, r."storagePath", r."fileSizeBytes", r."status"::text,
           r."visibility"::text, r."updatedAt", r."deletedAt", concat_ws(' ', u."firstName", u."lastName")
    from public."resources" r
    left join public."users" u on u."userId" = r."uploadedBy"
    order by r."updatedAt" desc;
end;
$$;

-- Called after the PDF is uploaded to resource-files. p_id null creates a draft record.
create function public.cms_save_resource(
    p_id bigint, p_title text, p_category text, p_storage_path text, p_file_size_bytes integer, p_visibility text
)
returns bigint language plpgsql security definer set search_path = ''
as $$
declare
    actor_id bigint := public.require_admin();
    previous jsonb;
    saved_id bigint;
begin
    if length(btrim(coalesce(p_title, ''))) = 0 or length(p_title) > 200 then
        raise invalid_parameter_value using message = 'Title must be 1 to 200 characters';
    end if;
    if length(btrim(coalesce(p_category, ''))) = 0 or length(p_category) > 60 then
        raise invalid_parameter_value using message = 'Category must be 1 to 60 characters';
    end if;
    if p_visibility not in ('public', 'private') then
        raise invalid_parameter_value using message = 'Unknown visibility';
    end if;
    if p_storage_path !~ '^[A-Za-z0-9._/-]+\.pdf$' then
        raise invalid_parameter_value using message = 'Resource file must be a PDF in resource-files';
    end if;

    if p_id is null then
        insert into public."resources" ("title", "category", "storagePath", "fileSizeBytes", "visibility", "uploadedBy")
        values (btrim(p_title), btrim(p_category), p_storage_path, p_file_size_bytes, p_visibility, actor_id)
        returning "resourceId" into saved_id;
    else
        select to_jsonb(r) into previous from public."resources" r where r."resourceId" = p_id and r."deletedAt" is null;
        if previous is null then
            raise no_data_found using message = 'Resource not found';
        end if;
        update public."resources"
        set "title" = btrim(p_title), "category" = btrim(p_category), "storagePath" = p_storage_path,
            "fileSizeBytes" = p_file_size_bytes, "visibility" = p_visibility, "updatedAt" = now()
        where "resourceId" = p_id
        returning "resourceId" into saved_id;
    end if;

    insert into public."auditLogs" ("performedBy", "action", "entityType", "entityId", "oldValue", "newValue")
    values (actor_id, case when p_id is null then 'resource.create' else 'resource.update' end, 'resources', saved_id,
            previous, jsonb_build_object('title', btrim(p_title), 'storagePath', p_storage_path, 'visibility', p_visibility));
    return saved_id;
end;
$$;
-- Manage Downloadable Resources END

-- Publish, Trash, Restore, Delete START (p_kind: 'content' or 'resource')
create function public.cms_set_status(p_kind text, p_id bigint, p_status text)
returns void language plpgsql security definer set search_path = ''
as $$
declare
    actor_id bigint := public.require_admin();
    previous text;
begin
    if p_status not in ('draft', 'published', 'archived') then
        raise invalid_parameter_value using message = 'Unknown status';
    end if;
    if p_kind = 'content' then
        select "status" into previous from public."cmsContent" where "contentId" = p_id and "deletedAt" is null;
        if previous is null then raise no_data_found using message = 'Content not found'; end if;
        update public."cmsContent"
        set "status" = p_status, "updatedBy" = actor_id, "updatedAt" = now(),
            "publishedAt" = case when p_status = 'published' then coalesce("publishedAt", now()) else "publishedAt" end
        where "contentId" = p_id;
    elsif p_kind = 'resource' then
        select "status" into previous from public."resources" where "resourceId" = p_id and "deletedAt" is null;
        if previous is null then raise no_data_found using message = 'Resource not found'; end if;
        update public."resources" set "status" = p_status, "updatedAt" = now() where "resourceId" = p_id;
    else
        raise invalid_parameter_value using message = 'Unknown item kind';
    end if;

    insert into public."auditLogs" ("performedBy", "action", "entityType", "entityId", "oldValue", "newValue")
    values (actor_id, 'cms.status', case when p_kind = 'content' then 'cmsContent' else 'resources' end, p_id,
            jsonb_build_object('status', previous), jsonb_build_object('status', p_status));
end;
$$;

create function public.cms_trash(p_kind text, p_id bigint, p_restore boolean default false)
returns void language plpgsql security definer set search_path = ''
as $$
declare
    actor_id bigint := public.require_admin();
    changed integer;
begin
    if p_kind = 'content' then
        update public."cmsContent"
        set "deletedAt" = case when p_restore then null else now() end, "updatedBy" = actor_id, "updatedAt" = now()
        where "contentId" = p_id and ("deletedAt" is null) = (not p_restore);
    elsif p_kind = 'resource' then
        update public."resources"
        set "deletedAt" = case when p_restore then null else now() end, "updatedAt" = now()
        where "resourceId" = p_id and ("deletedAt" is null) = (not p_restore);
    else
        raise invalid_parameter_value using message = 'Unknown item kind';
    end if;
    get diagnostics changed = row_count;
    if changed = 0 then raise no_data_found using message = 'Item not found'; end if;

    insert into public."auditLogs" ("performedBy", "action", "entityType", "entityId")
    values (actor_id, case when p_restore then 'cms.restore' else 'cms.trash' end,
            case when p_kind = 'content' then 'cmsContent' else 'resources' end, p_id);
end;
$$;

-- Permanent delete, only from the trash. For a resource it returns the PDF path so the
-- workspace can remove the file from resource-files afterwards.
create function public.cms_delete(p_kind text, p_id bigint)
returns text language plpgsql security definer set search_path = ''
as $$
declare
    actor_id bigint := public.require_admin();
    previous jsonb;
    file_path text;
begin
    if p_kind = 'content' then
        delete from public."cmsContent" c where c."contentId" = p_id and c."deletedAt" is not null
        returning to_jsonb(c.*) - 'body' into previous;
    elsif p_kind = 'resource' then
        delete from public."resources" r where r."resourceId" = p_id and r."deletedAt" is not null
        returning to_jsonb(r.*), r."storagePath" into previous, file_path;
    else
        raise invalid_parameter_value using message = 'Unknown item kind';
    end if;
    if previous is null then raise no_data_found using message = 'Item is not in the trash'; end if;

    insert into public."auditLogs" ("performedBy", "action", "entityType", "entityId", "oldValue")
    values (actor_id, 'cms.delete', case when p_kind = 'content' then 'cmsContent' else 'resources' end, p_id, previous);
    return file_path;
end;
$$;
-- Publish, Trash, Restore, Delete END

-- Temporary Privilege Grants START (Super Admin only; PB-05 / US-14)
-- Returns {granted: true, grantId} or, for an attempt on one's own account, {granted: false,
-- message}: that attempt is refused and still written to the audit log.
create function public.grant_privilege(p_user_id bigint, p_privilege text, p_expires_at timestamptz, p_reason text)
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

create function public.revoke_privilege(p_grant_id bigint)
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
create function public.list_privilege_grants()
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
-- Temporary Privilege Grants END

-- Function permissions START
-- Revoke everything, then grant only what browsers (signed-in staff) and the server may call.
do $$
declare f regprocedure;
begin
    for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' loop
        execute format('revoke all on function %s from public, anon, authenticated, service_role', f);
    end loop;
end $$;
grant execute on function
    public.get_staff_portal_role(), public.has_active_admin_access(), public.get_admin_access(),
    public.list_staff_accounts(integer), public.assign_staff_role(bigint, text),
    public.search_registrar_applications(text, text, date, date, integer), public.get_registrar_application(text),
    public.set_application_requirement(text, text, boolean), public.update_application_status(text, text, text),
    public.record_status_email(text, text, boolean), public.get_teacher_schedule(),
    public.cms_list_content(), public.cms_save_content(bigint, text, text, text, text, text, timestamptz, jsonb),
    public.cms_list_resources(), public.cms_save_resource(bigint, text, text, text, integer, text),
    public.cms_set_status(text, bigint, text), public.cms_trash(text, bigint, boolean), public.cms_delete(text, bigint),
    public.grant_privilege(bigint, text, timestamptz, text), public.revoke_privilege(bigint), public.list_privilege_grants(),
    -- The file-storage rules call this as the signed-in staff member, so uploads need it.
    public.has_content_admin_access()
    to authenticated;
grant execute on function public.can_manage_staff_accounts(uuid), public.is_super_admin(uuid),
    public.get_staff_auth_target(uuid, bigint) to service_role;
-- Function permissions END

-- ============================================================================
-- 7. FILE STORAGE
-- ============================================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
    ('resource-files', 'resource-files', true, 10485760, array['application/pdf']),
    ('content-images', 'content-images', true, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

-- Only Super Admins and Content Admins can upload, replace or remove website files. Visitors download through
-- the public bucket URLs.
create policy "Admins read website files" on storage.objects for select to authenticated
    using (bucket_id in ('resource-files', 'content-images') and public.has_content_admin_access());
create policy "Admins upload website files" on storage.objects for insert to authenticated
    with check (bucket_id in ('resource-files', 'content-images') and public.has_content_admin_access());
create policy "Admins replace website files" on storage.objects for update to authenticated
    using (bucket_id in ('resource-files', 'content-images') and public.has_content_admin_access());
create policy "Admins remove website files" on storage.objects for delete to authenticated
    using (bucket_id in ('resource-files', 'content-images') and public.has_content_admin_access());

commit;
