import { SubmissionError, type SaveInput, type Receipt } from './app.js';
import { mapEnrollment } from './enrollment-mapping.js';
import { ServiceError } from './service-error.js';

export interface TransactionClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

// Quotes a fixed camelCase column name from the server mapping (never client input).
const column = (name: string) => `"${name}"`;

// Only parameterized reads/inserts and transaction-scoped locks. No DDL,
// permission changes, stored functions, or additional tables are needed.
export async function saveEnrollment(client: TransactionClient, input: SaveInput): Promise<Receipt> {
  const mapped = mapEnrollment(input.data, input.periodId);
  const reference = `SNCS-${input.submissionId.replaceAll('-', '').toUpperCase()}`;
  try {
    await client.query('begin');
    await client.query("set local lock_timeout = '5s'");
    await client.query("set local statement_timeout = '10s'");
    const period = (await client.query(`select "schoolYearStart", "schoolYearEnd", "openedAt" is not null and "closedAt" is null as "isOpen"
      from public."enrollmentPeriods" where "periodId" = $1 for share`, [input.periodId])).rows[0];
    if (!period?.isOpen || `${period.schoolYearStart}-${period.schoolYearEnd}` !== input.data.schoolYear) throw new SubmissionError('closed');
    const grade = (await client.query('select "gradeLevelId" from public."gradeLevels" where "name" = $1', [mapped.gradeLevel])).rows[0];
    if (!grade) throw new SubmissionError('closed');
    const application: Record<string, unknown> = { ...mapped.application, gradeLevelId: grade.gradeLevelId };
    await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [input.ipHash]);
    await client.query('select pg_advisory_xact_lock(hashtextextended($1, 1))', [reference]);
    const existing = (await client.query(`select a."applicationId"::text as "applicationId", a."submitterIpHash",
      to_jsonb(a) || jsonb_build_object('periodId', a."periodId"::text, 'birthDate', a."birthDate"::text) as application
      from public."enrollmentApplications" a where a."referenceNo" = $1`, [reference])).rows[0];
    if (existing) {
      const saved = existing.application as Record<string, unknown>;
      const guardians = (await client.query(`select "relationship", "lastName", "firstName", "middleName", "suffix", "occupation",
        "contactNumber", "email", "messengerAccount" from public."applicationGuardians" where "applicationId" = $1 order by "relationship"`,
      [existing.applicationId])).rows;
      const sameGuardians = guardians.length === mapped.guardians.length && mapped.guardians.every(expected =>
        guardians.some(row => Object.entries(expected).every(([key, value]) => row[key] === value)));
      if (existing.submitterIpHash !== input.ipHash || !sameGuardians ||
        !Object.entries(application).every(([key, value]) => saved[key] === value)) throw new SubmissionError('conflict');
      await client.query('commit');
      return { reference, created: false };
    }
    const count = (await client.query(`select count(*)::int as count from public."enrollmentApplications"
      where "submitterIpHash" = $1 and "submittedAt" > now() - interval '1 hour'`, [input.ipHash])).rows[0];
    if (Number(count?.count) >= 5) throw new SubmissionError('rate_limit');
    const entries = Object.entries(application);
    const placeholders = entries.map((_, index) => `$${index + 3}`).join(', ');
    const saved = (await client.query(`insert into public."enrollmentApplications"
      ("referenceNo", "submitterIpHash", ${entries.map(([name]) => column(name)).join(', ')}, "status", "privacyConsentAt")
      values ($1, $2, ${placeholders}, 'pending', now()) returning "applicationId"::text as "applicationId"`,
    [reference, input.ipHash, ...entries.map(([, value]) => value)])).rows[0];
    for (const guardian of mapped.guardians) {
      const fields = Object.entries(guardian);
      await client.query(`insert into public."applicationGuardians"
        ("applicationId", ${fields.map(([name]) => column(name)).join(', ')})
        values ($1, ${fields.map((_, index) => `$${index + 2}`).join(', ')})`,
      [saved.applicationId, ...fields.map(([, value]) => value)]);
    }
    await client.query('commit');
    return { reference, created: true };
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    if (error instanceof SubmissionError) throw error;
    throw new ServiceError('Application save failed', error && typeof error === 'object' && 'code' in error ? error.code : undefined, 'database_transaction');
  }
}
