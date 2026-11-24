import { randomUUID } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { validApplication } from '../src/lib/enrollment/fixtures';
import { saveEnrollment, type TransactionClient } from './enrollment-transaction';
import type { Application } from '../src/lib/enrollment/form';
import { createTestDatabase } from './testing/database';

const ipHash = 'a'.repeat(64);
const otherIpHash = 'b'.repeat(64);

describe('PB-12 transaction against the ERD v12 schema', () => {
  let db: PGlite;
  let client: TransactionClient;
  let originalStructure: unknown;
  let originalSecurity: unknown;
  let originalIndexes: unknown;
  const structure = () => db.query(`select table_name, column_name, data_type from information_schema.columns
    where table_schema = 'public' order by table_name, ordinal_position`);
  const security = () => db.query("select relname, relrowsecurity, relacl from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' order by relname");
  const indexes = () => db.query("select indexname, indexdef from pg_indexes where schemaname = 'public' order by indexname");
  beforeAll(async () => {
    db = await createTestDatabase();
    client = { query: (text, values) => db.query(text, values) };
    await db.exec(`insert into public."enrollmentPeriods" ("schoolYearStart", "schoolYearEnd", "openedAt") values (2026, 2027, now())`);
    originalStructure = (await structure()).rows;
    originalSecurity = (await security()).rows;
    originalIndexes = (await indexes()).rows;
  }, 30_000);
  beforeEach(async () => {
    await db.exec(`truncate public."enrollmentApplications" cascade;
      update public."enrollmentPeriods" set "closedAt" = now() where "periodId" <> 1;
      update public."enrollmentPeriods" set "openedAt" = now(), "closedAt" = null, "schoolYearStart" = 2026, "schoolYearEnd" = 2027 where "periodId" = 1`);
  });
  afterAll(async () => { await db?.close(); });
  const submit = (id = randomUUID(), hash = ipHash, data: Application = validApplication, periodId = '1') =>
    saveEnrollment(client, { submissionId: id, ipHash: hash, data, periodId });

  it('saves application and guardians in camelCase columns without changing schema or adding helper objects', async () => {
    const first = await submit();
    expect(first.reference).toMatch(/^SNCS-[A-F0-9]{32}$/);
    const app = (await db.query<Record<string, unknown>>('select * from public."enrollmentApplications"')).rows[0];
    expect(app).toMatchObject({
      gradeLevelId: 9, applicantType: 'new', paymentMode: 'monthly', status: 'pending', strandCode: null, submitterIpHash: ipHash,
      lastName: 'Example', firstName: 'Test', houseStreet: '12 Test Street', barangay: 'Test Barangay', cityMunicipality: 'Taguig',
      province: 'Metro Manila', zipCode: '1630', primaryContactNumber: '09171234567', secondaryContactNumber: null,
      lastSchoolName: 'Example School', lastSchoolCityMunicipality: 'Taguig', lastSchoolProvince: 'Metro Manila', sex: 'female',
    });
    expect(app.privacyConsentAt).toBeTruthy(); expect(app.registrarRemarks).toBeNull();
    expect((await db.query('select "relationship", "lastName", "firstName", "messengerAccount" from public."applicationGuardians"')).rows)
      .toEqual([{ relationship: 'guardian', lastName: 'Example', firstName: 'Guardian', messengerAccount: 'Example Guardian' }]);
    expect((await structure()).rows).toEqual(originalStructure);
    expect((await security()).rows).toEqual(originalSecurity);
    expect((await indexes()).rows).toEqual(originalIndexes);
    expect((await db.query('select * from public."applicationDocuments"')).rows).toEqual([]);
  });
  it('enforces the rolling rate limit and permits identical retries after five saves', async () => {
    const id = randomUUID(); const first = await submit(id);
    for (let i = 0; i < 4; i++) await submit();
    await expect(submit()).rejects.toMatchObject({ code: 'rate_limit' });
    expect(await submit(id)).toEqual({ ...first, created: false });
    await expect(submit(randomUUID(), otherIpHash)).resolves.toBeTruthy();
    await db.exec(`update public."enrollmentApplications" set "submittedAt" = now() - interval '61 minutes'`);
    await expect(submit()).resolves.toBeTruthy();
  });
  it('rejects retry identifiers reused with different student, parent, period or IP details', async () => {
    const id = randomUUID(); await submit(id);
    await expect(submit(id, otherIpHash)).rejects.toMatchObject({ code: 'conflict' });
    await expect(submit(id, ipHash, { ...validApplication, firstName: 'Changed' })).rejects.toMatchObject({ code: 'conflict' });
    await expect(submit(id, ipHash, { ...validApplication, guardianContact: '09981234567' })).rejects.toMatchObject({ code: 'conflict' });
    await db.exec(`update public."enrollmentPeriods" set "closedAt" = now();
      insert into public."enrollmentPeriods" ("schoolYearStart", "schoolYearEnd", "openedAt") values (2026, 2027, now())`);
    await expect(submit(id, ipHash, validApplication, '2')).rejects.toMatchObject({ code: 'conflict' });
    expect((await db.query('select "applicationId" from public."enrollmentApplications"')).rows).toHaveLength(1);
  });
  it('rejects closed, nonexistent and changed-year periods', async () => {
    await expect(submit(undefined, undefined, validApplication, '999')).rejects.toMatchObject({ code: 'closed' });
    await db.exec(`update public."enrollmentPeriods" set "closedAt" = now()`);
    await expect(submit()).rejects.toMatchObject({ code: 'closed' });
    await db.exec(`update public."enrollmentPeriods" set "closedAt" = null, "schoolYearStart" = 2027, "schoolYearEnd" = 2028 where "periodId" = 1`);
    await expect(submit()).rejects.toMatchObject({ code: 'closed' });
    expect((await db.query('select "applicationId" from public."enrollmentApplications"')).rows).toEqual([]);
  });
  it.each([
    ['Preschool', 'Nursery', 'preschool', null], ['Preschool', 'Kindergarten', 'preschool', null],
    ['Elementary', 'Grade 1', 'grade_school', null], ['JHS', 'Grade 10', 'jhs', null], ['SHS', 'Grade 12', 'shs', '12-STEM'],
  ])('maps %s %s to the grade level list', async (level, gradeLevel, department, strand) => {
    await submit(undefined, undefined, { ...validApplication, level, gradeLevel, strand: strand ?? '' });
    expect((await db.query(`select g."department", g."name", a."strandCode" from public."enrollmentApplications" a
      join public."gradeLevels" g using ("gradeLevelId")`)).rows[0]).toEqual({ department, name: gradeLevel, strandCode: strand });
  });
  it('rolls back the application when a guardian insert fails', async () => {
    let inserts = 0;
    const failing: TransactionClient = { query: (text, values) => {
      if (text.includes('insert into public."applicationGuardians"') && ++inserts === 2) throw new Error('simulated failure with private details');
      return client.query(text, values);
    } };
    await expect(saveEnrollment(failing, { submissionId: randomUUID(), periodId: '1', ipHash,
      data: { ...validApplication, fatherLastName: 'Example', fatherFirstName: 'Father' } })).rejects.toThrow('Application save failed');
    expect((await db.query('select "applicationId" from public."enrollmentApplications"')).rows).toEqual([]);
    expect((await db.query('select "guardianId" from public."applicationGuardians"')).rows).toEqual([]);
  });
  it('uses parameterized values for quotes and SQL-shaped field contents', async () => {
    await submit(undefined, undefined, { ...validApplication, surname: "O'Connor", houseStreet: "Street'); drop table users; --" });
    expect((await db.query('select "lastName", "houseStreet" from public."enrollmentApplications"')).rows[0])
      .toMatchObject({ lastName: "O'Connor", houseStreet: "Street'); drop table users; --" });
    expect((await structure()).rows).toEqual(originalStructure);
  });
});
