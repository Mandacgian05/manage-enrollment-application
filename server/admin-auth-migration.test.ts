/*
 * Author: Jan Sultan | Email: jgsultan@student.apc.edu.ph
 * Created Date: 20261113
 * Modified by: Jan Sultan | Email: jgsultan@student.apc.edu.ph
 * Modified Date: 20261119
 * Modified by: Gian Mandac (ERD v12 schema: camelCase, split names, three Admin kinds)
 * Modified Date: 20261125
 */
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validApplication } from "../src/lib/enrollment/fixtures";
import { saveEnrollment } from "./enrollment-transaction";
import { asUser as runAs, createTestDatabase } from "./testing/database";

describe("staff authorization (ERD v12 schema)", () => {
  let db: PGlite;
  const contentAdminId = "00000000-0000-4000-8000-000000000001";
  const teacherId = "00000000-0000-4000-8000-000000000002";
  const inactiveId = "00000000-0000-4000-8000-000000000003";
  const unlinkedId = "00000000-0000-4000-8000-000000000004";
  const resetId = "00000000-0000-4000-8000-000000000005";
  const registrarId = "00000000-0000-4000-8000-000000000006";
  const superAdminId = "00000000-0000-4000-8000-000000000007";
  const accountAdminId = "00000000-0000-4000-8000-000000000014";
  const coordinatorId = "00000000-0000-4000-8000-000000000012";
  let reference: string;

  const asUser = <T>(userId: string, sql: string, values: unknown[] = [], sessionId = userId) =>
    runAs<T>(db, userId, sql, values, sessionId);

  beforeAll(async () => {
    db = await createTestDatabase();
    await db.query("insert into auth.users (id) select unnest($1::uuid[])", [[
      contentAdminId, teacherId, inactiveId, unlinkedId, resetId, registrarId, superAdminId, accountAdminId, coordinatorId,
    ]]);
    await db.exec("insert into auth.sessions (id, user_id) select id, id from auth.users");
    await db.query(`
      insert into public."users" ("email", "firstName", "lastName", "role", "adminType", "status", "authUserId", "mustChangePassword") values
        ('admin@example.com', 'Content', 'Admin', 'admin', 'contentAdmin', 'active', $1, false),
        ('teacher@example.com', 'Test', 'Teacher', 'teacher', null, 'active', $2, false),
        ('inactive@example.com', 'Inactive', 'Admin', 'admin', 'superAdmin', 'inactive', $3, false),
        ('reset@example.com', 'Reset', 'Registrar', 'registrar', null, 'active', $4, true),
        ('registrar@example.com', 'Test', 'Registrar', 'registrar', null, 'active', $5, false),
        ('manager@example.com', 'Super', 'Admin', 'admin', 'superAdmin', 'active', $6, false),
        ('accounts@example.com', 'Account', 'Admin', 'admin', 'accountAdmin', 'active', $7, false),
        ('coordinator@example.com', 'Academic', 'Coordinator', 'academicCoordinator', null, 'active', $8, false)
    `, [contentAdminId, teacherId, inactiveId, resetId, registrarId, superAdminId, accountAdminId, coordinatorId]);
    await db.exec(`insert into public."enrollmentPeriods" ("schoolYearStart", "schoolYearEnd", "openedAt") values (2026, 2027, now())`);
    const receipt = await saveEnrollment({ query: (sql, values) => db.query(sql, values) }, {
      submissionId: "00000000-0000-4000-8000-000000000008", periodId: "1", ipHash: "a".repeat(64), data: validApplication,
    });
    reference = receipt.reference;
  }, 30_000);
  afterAll(async () => { await db?.close(); });

  it.each([
    ["Content Admin", contentAdminId, "admin"],
    ["Account Admin", accountAdminId, "admin"],
    ["active Registrar", registrarId, "registrar"],
    ["active Teacher", teacherId, "teacher"],
    ["active Academic Coordinator", coordinatorId, "academicCoordinator"],
    ["inactive admin", inactiveId, null],
    ["unlinked Auth user", unlinkedId, null],
    ["Registrar who must change their password", resetId, "password-change"],
    ["missing Auth subject", "", null],
  ])("checks the current role and status for %s", async (_name, userId, role) => {
    const result = await asUser(userId, "select public.get_staff_portal_role() as role, public.has_active_admin_access() as admin");
    expect(result.rows).toEqual([{ role, admin: role === "admin" }]);
  });

  it("tells each kind of Admin what they may open", async () => {
    const access = async (userId: string) => (await asUser<{ a: unknown }>(userId, "select public.get_admin_access() as a")).rows[0].a;
    expect(await access(superAdminId)).toEqual({ adminType: "superAdmin", manageAccounts: true, manageStaff: true, manageContent: true });
    expect(await access(accountAdminId)).toEqual({ adminType: "accountAdmin", manageAccounts: true, manageStaff: false, manageContent: false });
    expect(await access(contentAdminId)).toEqual({ adminType: "contentAdmin", manageAccounts: false, manageStaff: false, manageContent: true });
    expect(await access(registrarId)).toBeNull();
  });

  it("blocks anonymous access to the functions and prevents browser role escalation", async () => {
    await expect(db.transaction(async (tx) => {
      await tx.exec("set local role anon");
      await tx.query("select public.get_staff_portal_role()");
    })).rejects.toMatchObject({ code: "42501" });
    await expect(asUser(teacherId, `update public."users" set "role" = 'admin' where "authUserId" = $1`, [teacherId]))
      .rejects.toMatchObject({ code: "42501" });
    await expect(asUser(teacherId, `select "email" from public."users"`)).rejects.toMatchObject({ code: "42501" });
  });

  it("denies Teacher access when the JWT session is missing or belongs to another account", async () => {
    const sql = "select public.get_staff_portal_role() as role";
    for (const sessionId of ["", registrarId]) {
      expect((await asUser(teacherId, sql, [], sessionId)).rows).toEqual([{ role: null }]);
    }
  });

  it("links accounts provisioned by an account manager and rolls back a failed Auth transaction", async () => {
    const newId = "00000000-0000-4000-8000-000000000009";
    const provision = (actor: string, email: string, authId: string, role = "registrar") => db.transaction(async (tx) => {
      await tx.query("insert into auth.users (id, email) values ($1, $2)", [authId, email]);
      await tx.query("update auth.users set raw_app_meta_data = $1 where id = $2", [
        { chimera_staff_provisioning: { createdBy: actor, firstName: "New", middleName: "", lastName: "Staff", suffix: "Jr.", role } }, authId,
      ]);
    });
    await expect(provision(contentAdminId, "new@example.com", newId)).rejects.toMatchObject({ code: "42501" });
    expect((await db.query("select id from auth.users where id = $1", [newId])).rows).toEqual([]);
    await expect(provision(accountAdminId, "new@example.com", newId, "superAdmin")).rejects.toMatchObject({ code: "22023" });
    await expect(provision(superAdminId, "new@example.com", newId, "superAdmin")).rejects.toMatchObject({ code: "22023" });
    await expect(provision(superAdminId, "registrar@example.com", newId)).rejects.toMatchObject({ code: "23505" });
    expect((await db.query("select id from auth.users where id = $1", [newId])).rows).toEqual([]);
    await provision(accountAdminId, "NEW@example.com", newId);
    expect((await db.query(`select "email", "firstName", "middleName", "lastName", "suffix", "role", "adminType"
      from public."users" where "authUserId" = $1`, [newId])).rows)
      .toEqual([{ email: "new@example.com", firstName: "New", middleName: null, lastName: "Staff", suffix: "Jr.", role: "registrar", adminType: null }]);
    expect((await db.query(`select "action", "newValue" from public."auditLogs" where "action" = 'account.create'`)).rows)
      .toEqual([{ action: "account.create", newValue: { role: "registrar", adminType: null } }]);
  });

  it("lists accounts for Super Admins and Account Admins, but only a Super Admin assigns roles", async () => {
    const { rows: [account] } = await db.query<{ id: string }>(`select "userId"::text as id from public."users" where "authUserId" = $1`, [teacherId]);
    for (const userId of [contentAdminId, registrarId, teacherId, coordinatorId]) {
      await expect(asUser(userId, "select * from public.list_staff_accounts()")).rejects.toMatchObject({ code: "42501" });
      await expect(asUser(userId, "select public.assign_staff_role($1, 'registrar')", [account.id])).rejects.toMatchObject({ code: "42501" });
    }
    await expect(asUser(accountAdminId, "select public.assign_staff_role($1, 'registrar')", [account.id])).rejects.toMatchObject({ code: "42501" });
    const list = await asUser(accountAdminId, "select * from public.list_staff_accounts()");
    expect(list.rows).toContainEqual({ userId: account.id, firstName: "Test", middleName: null, lastName: "Teacher", suffix: null,
      email: "teacher@example.com", role: "teacher", adminType: null, status: "active" });
    await asUser(superAdminId, "select public.assign_staff_role($1, 'registrar')", [account.id]);
    expect((await asUser(teacherId, "select public.get_staff_portal_role() as role")).rows).toEqual([{ role: "registrar" }]);
    await asUser(superAdminId, "select public.assign_staff_role($1, 'teacher')", [account.id]);
    await expect(asUser(teacherId, "select * from public.search_registrar_applications()")).rejects.toMatchObject({ code: "42501" });
    expect((await db.query(`select "action" from public."auditLogs" where "entityId" = $1 and "entityType" = 'users' order by "auditLogId"`, [account.id])).rows)
      .toEqual([{ action: "role.change" }, { action: "role.change" }]);
  });

  it("stores Admin kinds as role admin plus adminType, and never grants Super Admin from the website", async () => {
    const { rows: [account] } = await db.query<{ id: string }>(`select "userId"::text as id from public."users" where "authUserId" = $1`, [coordinatorId]);
    const stored = async () => (await db.query(`select "role", "adminType" from public."users" where "userId" = $1`, [account.id])).rows[0];
    await asUser(superAdminId, "select public.assign_staff_role($1, 'contentAdmin')", [account.id]);
    expect(await stored()).toEqual({ role: "admin", adminType: "contentAdmin" });
    await expect(asUser(superAdminId, "select public.assign_staff_role($1, 'superAdmin')", [account.id])).rejects.toMatchObject({ code: "22023" });
    await expect(asUser(accountAdminId, "select public.assign_staff_role($1, 'registrar')", [account.id])).rejects.toMatchObject({ code: "42501" });
    await asUser(superAdminId, "select public.assign_staff_role($1, 'academicCoordinator')", [account.id]);
    expect(await stored()).toEqual({ role: "academicCoordinator", adminType: null });
    await expect(asUser(superAdminId, "select public.assign_staff_role($1, 'admin')", [account.id])).rejects.toMatchObject({ code: "22023" });
    // A Super Admin's own access can't be changed from the website.
    const { rows: [other] } = await db.query<{ id: string }>(`select "userId"::text as id from public."users" where "authUserId" = $1`, [inactiveId]);
    await db.query(`update public."users" set "status" = 'active' where "userId" = $1`, [other.id]);
    await expect(asUser(superAdminId, "select public.assign_staff_role($1, 'registrar')", [other.id])).rejects.toMatchObject({ code: "42501" });
    await db.query(`update public."users" set "status" = 'inactive' where "userId" = $1`, [other.id]);
    await expect(db.query(`update public."users" set "adminType" = null where "authUserId" = $1`, [contentAdminId])).rejects.toMatchObject({ code: "23514" });
  });

  // Reset and Deactivation Tests START
  it("locks out revoked sessions and requires the current reset before restoring dashboard access", async () => {
    const { rows: [account] } = await db.query<{ id: string }>(`select "userId"::text as id from public."users" where "authUserId" = $1`, [teacherId]);
    const freshSession = "00000000-0000-4000-8000-000000000010";
    const resetSession = "00000000-0000-4000-8000-000000000011";
    const role = "select public.get_staff_portal_role() as role";
    const authAction = (password: string, action: Record<string, string>) => db.transaction(async (tx) => {
      // Model the Auth Admin password update, session revocation, and metadata transaction.
      await tx.query("update auth.users set encrypted_password = $1 where id = $2", [password, teacherId]);
      await tx.query("delete from auth.sessions where user_id = $1", [teacherId]);
      await tx.query("update auth.users set raw_app_meta_data = $1 where id = $2", [{ chimera_staff_action: action }, teacherId]);
    });
    const reset = { action: "reset-password", staff_id: account.id, actor_id: superAdminId, request_id: "reset-1" };
    await expect(authAction("rejected", { ...reset, actor_id: contentAdminId })).rejects.toMatchObject({ code: "42501" });
    await expect(authAction("rejected", { ...reset, actor_id: accountAdminId })).rejects.toMatchObject({ code: "42501" });
    expect((await asUser(teacherId, role)).rows).toEqual([{ role: "teacher" }]);
    await authAction("temporary", reset);
    expect((await asUser(teacherId, role)).rows).toEqual([{ role: null }]);
    await db.query("insert into auth.sessions values ($1, $2)", [resetSession, teacherId]);
    expect((await asUser(teacherId, role, [], resetSession)).rows).toEqual([{ role: "password-change" }]);
    const complete = { action: "complete-password-change", reset_id: "reset-1", request_id: "complete-1" };
    await expect(authAction("rejected", { ...complete, reset_id: "older-reset" })).rejects.toMatchObject({ code: "42501" });
    expect((await asUser(teacherId, role, [], resetSession)).rows).toEqual([{ role: "password-change" }]);
    await authAction("new-password", complete);
    expect((await asUser(teacherId, role, [], resetSession)).rows).toEqual([{ role: null }]);
    await db.query("insert into auth.sessions values ($1, $2)", [freshSession, teacherId]);
    expect((await asUser(teacherId, role, [], freshSession)).rows).toEqual([{ role: "teacher" }]);
    await authAction("unavailable", { ...reset, action: "deactivate", request_id: "deactivate-1" });
    expect((await asUser(teacherId, role, [], freshSession)).rows).toEqual([{ role: null }]);
    await db.query("insert into auth.sessions values ($1, $2) on conflict do nothing", [freshSession, teacherId]);
    expect((await asUser(teacherId, role, [], freshSession)).rows).toEqual([{ role: null }]);
    expect((await db.query(`select "action", "performedBy" = (select "userId" from public."users" where "authUserId" = $1) as authorized
      from public."auditLogs" where "entityId" = $2 and "action" like 'account.%' order by "auditLogId"`, [superAdminId, account.id])).rows)
      .toEqual([{ action: "account.password_reset", authorized: true }, { action: "account.deactivate", authorized: true }]);
  });
  // Reset and Deactivation Tests END

  // Manage Enrollment Application Tests START
  it("searches and filters applications only for an active Registrar", async () => {
    const search = (args: unknown[]) => asUser<{ referenceNo: string }>(registrarId,
      `select "referenceNo" from public.search_registrar_applications($1::text, $2::text, $3::date, $4::date)`, args);
    expect((await search(["example, test", null, null, null])).rows).toEqual([{ referenceNo: reference }]);
    expect((await search([reference.slice(5, 15).toLowerCase(), "pending", null, null])).rows).toEqual([{ referenceNo: reference }]);
    expect((await search(["%", null, null, null])).rows).toEqual([]);
    expect((await search([null, "complete", null, null])).rows).toEqual([]);
    expect((await search([null, null, "2000-01-01", "2000-01-02"])).rows).toEqual([]);
    await expect(search([null, "approved", null, null])).rejects.toMatchObject({ code: "22023" });
    for (const userId of [contentAdminId, teacherId, resetId, ""]) {
      await expect(asUser(userId, "select * from public.search_registrar_applications()")).rejects.toMatchObject({ code: "42501" });
    }
  });

  it("returns full application details without the submitter IP hash", async () => {
    const { rows: [{ detail }] } = await asUser<{ detail: Record<string, unknown> }>(registrarId,
      "select public.get_registrar_application($1) as detail", [reference]);
    expect(detail).toMatchObject({
      referenceNo: reference, lastName: "Example", gradeLevel: "Grade 7", department: "jhs", applicantType: "new",
      schoolYearStart: 2026, schoolYearEnd: 2027, houseStreet: "12 Test Street", cityMunicipality: "Taguig",
      guardians: [{ relationship: "guardian", lastName: "Example", firstName: "Guardian", messengerAccount: "Example Guardian" }],
      documents: [], requirementChecks: {},
    });
    expect(detail).not.toHaveProperty("submitterIpHash");
    expect((await asUser(registrarId, "select public.get_registrar_application('SNCS-UNKNOWN') as detail")).rows).toEqual([{ detail: null }]);
    await expect(asUser(contentAdminId, "select public.get_registrar_application($1)", [reference])).rejects.toMatchObject({ code: "42501" });
  });

  it("records requirement checks, status changes and confirmed emails in the audit trail", async () => {
    await asUser(registrarId, "select public.set_application_requirement($1, 'psa-birth-certificate', true)", [reference]);
    await expect(asUser(registrarId, "select public.set_application_requirement($1, 'Bad Key', true)", [reference])).rejects.toMatchObject({ code: "22023" });
    await expect(asUser(registrarId, "select public.update_application_status($1, 'pending', null)", [reference])).rejects.toMatchObject({ code: "22023" });
    await expect(asUser(registrarId, "select public.update_application_status('SNCS-UNKNOWN', 'complete', null)")).rejects.toMatchObject({ code: "P0002" });
    await expect(asUser(contentAdminId, "select public.update_application_status($1, 'complete', null)", [reference])).rejects.toMatchObject({ code: "42501" });

    const update = (remarks: string) => asUser<{ result: unknown }>(registrarId,
      "select public.update_application_status($1, 'incomplete', $2) as result", [reference, remarks]);
    expect((await update("  Missing PSA copy  ")).rows).toEqual([{ result: { status: "incomplete", registrarRemarks: "Missing PSA copy", changed: true } }]);
    expect((await update("Missing PSA copy")).rows).toEqual([{ result: { status: "incomplete", registrarRemarks: "Missing PSA copy", changed: false } }]);
    await asUser(registrarId, "select public.record_status_email($1, 'incomplete', true)", [reference]);

    const { rows: [{ detail }] } = await asUser<{ detail: Record<string, unknown> }>(registrarId,
      "select public.get_registrar_application($1) as detail", [reference]);
    expect(detail).toMatchObject({ status: "incomplete", registrarRemarks: "Missing PSA copy", requirementChecks: { "psa-birth-certificate": true } });
    expect((await db.query(`select "action", "oldValue", "newValue",
        "performedBy" = (select "userId" from public."users" where "authUserId" = $1) as "byRegistrar"
      from public."auditLogs" where "entityType" = 'enrollmentApplications' order by "auditLogId"`, [registrarId])).rows).toEqual([
      { action: "application.requirement_check", oldValue: null, newValue: { requirementKey: "psa-birth-certificate", isReceived: true }, byRegistrar: true },
      { action: "application.status_change", oldValue: { status: "pending", registrarRemarks: null },
        newValue: { status: "incomplete", registrarRemarks: "Missing PSA copy" }, byRegistrar: true },
      { action: "application.status_email", oldValue: null, newValue: { status: "incomplete" }, byRegistrar: true },
    ]);
  });

  it("keeps browser sessions away from the enrollment tables", async () => {
    for (const table of ["enrollmentApplications", "applicationGuardians", "applicationDocuments", "applicationRequirementChecks", "auditLogs"]) {
      await expect(asUser(registrarId, `select * from public."${table}"`)).rejects.toMatchObject({ code: "42501" });
    }
    await expect(asUser(registrarId, `update public."enrollmentApplications" set "status" = 'complete'`)).rejects.toMatchObject({ code: "42501" });
    await expect(db.transaction(async (tx) => {
      await tx.exec("set local role anon");
      await tx.query(`select * from public."enrollmentApplications"`);
    })).rejects.toMatchObject({ code: "42501" });
  });
  // Manage Enrollment Application Tests END

  // Manage Website Content Tests START
  it("lets Super Admins and Content Admins publish website content that visitors can then read", async () => {
    const save = (userId: string, slug: string) => asUser<{ id: string }>(userId,
      "select public.cms_save_content(null, 'announcement', 'Enrollment opens', $1, 'Short', 'Body') as id", [slug]);
    await expect(save(accountAdminId, "denied")).rejects.toMatchObject({ code: "42501" });
    await expect(save(registrarId, "denied")).rejects.toMatchObject({ code: "42501" });
    const { rows: [{ id }] } = await save(contentAdminId, "enrollment-opens");
    const visible = () => db.transaction(async (tx) => {
      await tx.exec("set local role anon");
      return (await tx.query(`select "title" from public."cmsContent"`)).rows;
    });
    expect(await visible()).toEqual([]);
    await asUser(superAdminId, "select public.cms_set_status('content', $1, 'published')", [id]);
    expect(await visible()).toEqual([{ title: "Enrollment opens" }]);
    await asUser(contentAdminId, "select public.cms_trash('content', $1)", [id]);
    expect(await visible()).toEqual([]);
    await expect(asUser(contentAdminId, "select public.cms_delete('content', 999)")).rejects.toMatchObject({ code: "P0002" });
    await asUser(contentAdminId, "select public.cms_delete('content', $1)", [id]);
    expect((await db.query<{ action: string }>(`select "action" from public."auditLogs" where "entityType" = 'cmsContent' order by "auditLogId"`)).rows.map((row) => row.action))
      .toEqual(["cms.create", "cms.status", "cms.trash", "cms.delete"]);
  });
  // Manage Website Content Tests END
});
