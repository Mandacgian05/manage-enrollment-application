/*
 * Temporary privilege grants (PB-05 / US-14 criteria 4, 5, 6 and 7) and the content
 * workspace's database functions (PB-01), against the v12 schema.
 */
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asUser as runAs, createTestDatabase } from "./testing/database";

describe("temporary privilege grants", () => {
  let db: PGlite;
  const superAdmin = "00000000-0000-4000-8000-000000000101";
  const accountAdmin = "00000000-0000-4000-8000-000000000102";
  const contentAdmin = "00000000-0000-4000-8000-000000000103";
  const registrar = "00000000-0000-4000-8000-000000000104";
  const ids: Record<string, number> = {};
  const asUser = <T>(user: string, sql: string, values: unknown[] = []) => runAs<T>(db, user, sql, values);
  const access = async (user: string) =>
    (await asUser<{ access: Record<string, unknown> }>(user, "select public.get_admin_access() as access")).rows[0].access;
  const grant = (user: string, target: number, privilege: string, expires = "now() + interval '2 days'", reason = "Covering for a colleague") =>
    asUser<{ result: { granted: boolean; message?: string; grantId?: number } }>(user,
      `select public.grant_privilege($1, $2, ${expires}, $3) as result`, [target, privilege, reason]);

  beforeAll(async () => {
    db = await createTestDatabase();
    await db.query("insert into auth.users (id) select unnest($1::uuid[])", [[superAdmin, accountAdmin, contentAdmin, registrar]]);
    await db.exec("insert into auth.sessions (id, user_id) select id, id from auth.users");
    const { rows } = await db.query<{ userId: number; email: string }>(`
      insert into public."users" ("email", "firstName", "lastName", "role", "adminType", "authUserId") values
        ('super@example.com', 'Super', 'Admin', 'admin', 'superAdmin', $1),
        ('accounts@example.com', 'Jan', 'Sultan', 'admin', 'accountAdmin', $2),
        ('content@example.com', 'Terrence', 'Corpuz', 'admin', 'contentAdmin', $3),
        ('registrar@example.com', 'Gian', 'Mandac', 'registrar', null, $4)
      returning "userId", "email"`, [superAdmin, accountAdmin, contentAdmin, registrar]);
    for (const row of rows) ids[row.email.split("@")[0]] = Number(row.userId);
  }, 30_000);
  afterAll(async () => { await db?.close(); });

  it("lets only a Super Admin give access, and refuses and logs a grant to oneself", async () => {
    await expect(grant(contentAdmin, ids.accounts, "manageContent")).rejects.toThrow("Only a Super Admin");
    const self = await grant(superAdmin, ids.super, "manageContent");
    expect(self.rows[0].result).toEqual({ granted: false, message: "You cannot change your own privileges." });
    const { rows } = await db.query<{ action: string }>(`select "action" from public."auditLogs" where "action" = 'privilege.grant.rejected'`);
    expect(rows).toHaveLength(1);
  });

  it("requires a future end date, a reason and an Admin who does not already have the access", async () => {
    await expect(grant(superAdmin, ids.content, "manageStaffAccounts", "now() - interval '1 hour'")).rejects.toThrow("future");
    await expect(grant(superAdmin, ids.content, "manageStaffAccounts", undefined, "no")).rejects.toThrow("reason");
    await expect(grant(superAdmin, ids.content, "manageContent")).rejects.toThrow("already has this access");
    await expect(grant(superAdmin, ids.registrar, "manageContent")).rejects.toThrow("Admin accounts only");
    await expect(grant(superAdmin, ids.content, "manageStaffAccounts", "now() + interval '400 days'")).rejects.toThrow("one year");
  });

  it("opens account management to the Content Admin until the grant ends", async () => {
    expect(await access(contentAdmin)).toMatchObject({ manageAccounts: false, temporaryAccess: [] });
    await expect(asUser(contentAdmin, "select * from public.list_staff_accounts(0)")).rejects.toThrow("management access");

    const given = await grant(superAdmin, ids.content, "manageStaffAccounts");
    expect(given.rows[0].result.granted).toBe(true);
    await expect(grant(superAdmin, ids.content, "manageStaffAccounts")).rejects.toThrow("Revoke it first");
    expect(await access(contentAdmin)).toMatchObject({ manageAccounts: true, manageStaff: false,
      temporaryAccess: [expect.objectContaining({ privilege: "manageStaffAccounts" })] });
    expect((await asUser(contentAdmin, "select * from public.list_staff_accounts(0)")).rows).toHaveLength(4);

    await db.exec(`update public."privilegeGrants" set "grantedAt" = now() - interval '3 days', "expiresAt" = now() - interval '1 second'`);
    expect(await access(contentAdmin)).toMatchObject({ manageAccounts: false, temporaryAccess: [] });
    await expect(asUser(contentAdmin, "select * from public.list_staff_accounts(0)")).rejects.toThrow("management access");
  });

  it("opens the content functions to the Account Admin, and closes them when revoked", async () => {
    await expect(asUser(accountAdmin, "select * from public.cms_list_content()")).rejects.toThrow("Content Admin access");
    const given = await grant(superAdmin, ids.accounts, "manageContent");
    await expect(asUser(accountAdmin, "select * from public.cms_list_content()")).resolves.toBeDefined();

    await expect(asUser(accountAdmin, "select public.revoke_privilege($1)", [given.rows[0].result.grantId])).rejects.toThrow("Only a Super Admin");
    const revoked = await asUser<{ result: { revoked: boolean } }>(superAdmin, "select public.revoke_privilege($1) as result", [given.rows[0].result.grantId]);
    expect(revoked.rows[0].result.revoked).toBe(true);
    await expect(asUser(accountAdmin, "select * from public.cms_list_content()")).rejects.toThrow("Content Admin access");

    const history = await asUser<{ staffName: string; active: boolean; revokedAt: string | null }>(superAdmin,
      `select "staffName", "active", "revokedAt" from public.list_privilege_grants()`);
    expect(history.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ staffName: "Jan Sultan", active: false, revokedAt: expect.anything() }),
      expect.objectContaining({ staffName: "Terrence Corpuz", active: false, revokedAt: null }),
    ]));
    const { rows } = await db.query<{ action: string }>(`select "action" from public."auditLogs" where "action" like 'privilege.%' order by "auditLogId"`);
    expect(rows.map((row) => row.action)).toEqual(["privilege.grant.rejected", "privilege.grant", "privilege.grant", "privilege.revoke"]);
  });

  it("lets signed-in staff run the upload check used by the file storage rules", async () => {
    const { rows } = await asUser<{ allowed: boolean }>(contentAdmin, "select public.has_content_admin_access() as allowed");
    expect(rows[0].allowed).toBe(true);
    const registrarCheck = await asUser<{ allowed: boolean }>(registrar, "select public.has_content_admin_access() as allowed");
    expect(registrarCheck.rows[0].allowed).toBe(false);
  });

  it("saves, publishes, trashes and deletes website content, recording the editor", async () => {
    const saved = await asUser<{ id: number }>(contentAdmin,
      "select public.cms_save_content(null, 'announcement', 'Exam week', 'exam-week', 'Exams start Monday.', 'Exams start Monday.') as id");
    const id = saved.rows[0].id;
    await asUser(contentAdmin, "select public.cms_set_status('content', $1, 'published')", [id]);
    const visitor = await db.transaction(async (tx) => {
      await tx.exec("set local role anon");
      return tx.query<{ slug: string }>(`select "slug" from public."cmsContent"`);
    });
    expect(visitor.rows).toEqual([{ slug: "exam-week" }]);
    const listed = await asUser<{ updatedByName: string; status: string; publishedAt: string | null }>(contentAdmin,
      `select "updatedByName", "status", "publishedAt" from public.cms_list_content()`);
    expect(listed.rows[0]).toMatchObject({ updatedByName: "Terrence Corpuz", status: "published", publishedAt: expect.anything() });

    await asUser(contentAdmin, "select public.cms_trash('content', $1, false)", [id]);
    const hidden = await db.transaction(async (tx) => {
      await tx.exec("set local role anon");
      return tx.query(`select 1 from public."cmsContent"`);
    });
    expect(hidden.rows).toHaveLength(0);
    await asUser(contentAdmin, "select public.cms_delete('content', $1)", [id]);
    expect((await db.query(`select 1 from public."cmsContent"`)).rows).toHaveLength(0);
  });
});
