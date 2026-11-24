/*
 * Author: Gian Mandac
 * Created Date: 20261117
 * PB-07 / US-07: a Teacher sees only their own published class meetings.
 * Modified Date: 20261125 (ERD v12 schema: timeSlots, sectionStrands, teaching profile)
 */
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asUser as runAs, createTestDatabase } from "./testing/database";

describe("teacher schedule (ERD v12 schema)", () => {
  let db: PGlite;
  const teacherA = "00000000-0000-4000-8000-0000000000a1";
  const teacherB = "00000000-0000-4000-8000-0000000000b2";
  const unlinked = "00000000-0000-4000-8000-0000000000c3";
  const registrar = "00000000-0000-4000-8000-0000000000d4";
  const admin = "00000000-0000-4000-8000-0000000000e5";
  const publishedRun = 3;

  const asUser = <T>(userId: string, sql: string) => runAs<T>(db, userId, sql);
  const schedule = async (userId: string) =>
    (await asUser<{ s: Record<string, unknown> }>(userId, "select public.get_teacher_schedule() as s")).rows[0].s;

  beforeAll(async () => {
    db = await createTestDatabase();
    const ids = [teacherA, teacherB, unlinked, registrar, admin];
    await db.query("insert into auth.users (id) select unnest($1::uuid[])", [ids]);
    await db.exec("insert into auth.sessions (id, user_id) select id, id from auth.users");
    await db.query(`
      insert into public."users" ("email", "firstName", "lastName", "role", "adminType", "authUserId") values
        ('a@example.com', 'Teacher', 'A', 'teacher', null, $1),
        ('b@example.com', 'Teacher', 'B', 'teacher', null, $2),
        ('c@example.com', 'Unlinked', 'Teacher', 'teacher', null, $3),
        ('r@example.com', 'Test', 'Registrar', 'registrar', null, $4),
        ('admin@example.com', 'Test', 'Admin', 'admin', 'superAdmin', $5)`, ids);
    await db.exec(`
      insert into public."teachers" ("userId", "employeeNumber", "department", "employmentStatus", "dateHired", "highestDegree", "degreeMajor")
        select "userId", 'T01', 'jhs', 'regular', '2020-06-01', 'BSEd', 'Filipino' from public."users" where "email" = 'a@example.com'
        union all select "userId", 'T02', 'jhs', 'regular', '2021-06-01', 'BSEd', 'Mathematics' from public."users" where "email" = 'b@example.com';
      insert into public."terms" ("schoolYearStart", "schoolYearEnd", "name", "isActive") values (2026, 2027, 'Term 2', true);
      insert into public."subjectAreas" ("name") values ('Filipino'), ('Science'), ('Mathematics');
      insert into public."rooms" ("roomNumber", "roomName", "roomType") values ('201', 'Room 201', 'classroom'), ('L1', 'Chemistry Lab', 'laboratory');
      insert into public."sections" ("termId", "gradeLevelId", "name") values (1, 9, 'G7 - Our Lady of Guadalupe'), (1, 13, 'G11 - St. Thomas');
      insert into public."sectionStrands" ("sectionId", "strandCode") values (2, 'STEM');
      insert into public."subjects" ("name", "gradeLevelId", "subjectAreaId", "subjectType") values
        ('Filipino 7', 9, 1, 'core'), ('General Chemistry 1', 13, 2, 'strand'), ('Math 7', 9, 3, 'core');
      insert into public."teacherLoads" ("teacherId", "subjectId", "sectionId", "meetings60PerWeek") values (1, 1, 1, 4), (1, 2, 2, 2), (2, 3, 1, 4);
      insert into public."timeSlots" ("termId", "recessGroup", "dayOfWeek", "slotOrder", "slotType", "startTime", "endTime") values
        (1, '7-8', 1, 1, 'class', '07:00', '08:00'), (1, '7-8', 2, 1, 'class', '07:00', '08:00'),
        (1, '11-12', 3, 3, 'class', '10:00', '11:00'), (1, '7-8', 1, 2, 'class', '08:00', '09:00'), (1, '7-8', 1, 3, 'class', '09:00', '10:00');
      insert into public."scheduleRuns" ("termId", "status", "generatedBy") values (1, 'superseded', 5), (1, 'draft', 5), (1, 'draft', 5);
      insert into public."scheduleEntries" ("runId", "teacherLoadId", "timeSlotId", "roomId", "isFixed") values
        (1, 1, 1, 1, false),   -- superseded: hidden
        (2, 1, 2, 1, false),   -- draft: hidden
        (3, 2, 3, 2, true),    -- run 3, Teacher A (lab, fixed)
        (3, 1, 4, 1, false),   -- run 3, Teacher A
        (3, 3, 5, null, false); -- run 3, Teacher B
    `);
  }, 30_000);
  afterAll(async () => { await db?.close(); });

  it("shows nothing while no schedule has been published", async () => {
    expect(await schedule(teacherA)).toEqual({ linked: true, teacherName: "Teacher A", run: null, entries: [] });
  });

  it("returns only the signed-in Teacher's meetings from the published run, in day and time order", async () => {
    await db.query(`update public."scheduleRuns" set "status" = 'published', "publishedAt" = now(), "publishedBy" = 5 where "runId" = $1`, [publishedRun]);
    const result = await schedule(teacherA);
    expect(result).toMatchObject({ linked: true, teacherName: "Teacher A", run: { schoolYearStart: 2026, schoolYearEnd: 2027, term: "Term 2" } });
    expect(result.entries).toEqual([
      { dayOfWeek: 1, startTime: "08:00", endTime: "09:00", subject: "Filipino 7", section: "G7 - Our Lady of Guadalupe",
        gradeLevel: "Grade 7", strands: null, room: "Room 201", isFixed: false },
      { dayOfWeek: 3, startTime: "10:00", endTime: "11:00", subject: "General Chemistry 1", section: "G11 - St. Thomas",
        gradeLevel: "Grade 11", strands: "STEM", room: "Chemistry Lab", isFixed: true },
    ]);
    expect((await schedule(teacherB)).entries).toEqual([expect.objectContaining({ subject: "Math 7", room: null })]);
  });

  it("refuses to book one teacher into two overlapping class meetings", async () => {
    await expect(db.query(`insert into public."scheduleEntries" ("runId", "teacherLoadId", "timeSlotId") values (3, 1, 3)`))
      .rejects.toMatchObject({ code: "23P01" });
  });

  it("tells a Teacher whose account has no teaching profile", async () => {
    expect(await schedule(unlinked)).toEqual({ linked: false, run: null, entries: [] });
  });

  it.each([registrar, admin, ""])("refuses non-Teacher sessions", async (userId) => {
    await expect(asUser(userId, "select public.get_teacher_schedule()")).rejects.toMatchObject({ code: "42501" });
  });

  it("blocks anonymous callers and direct table reads", async () => {
    await expect(db.transaction(async (tx) => {
      await tx.exec("set local role anon");
      await tx.query("select public.get_teacher_schedule()");
    })).rejects.toMatchObject({ code: "42501" });
    for (const table of ["scheduleEntries", "scheduleRuns", "rooms", "teachers"]) {
      await expect(asUser(teacherA, `select * from public."${table}"`)).rejects.toMatchObject({ code: "42501" });
    }
  });
});
