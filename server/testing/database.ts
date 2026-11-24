/*
 * Test support only: an in-memory Postgres (PGlite) with stand-ins for the Supabase
 * auth and storage schemas, loaded with supabase/schema/sncs-schema-v12.sql.
 */
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const supabaseStandIns = `
  create role anon; create role authenticated; create role service_role;
  create schema auth;
  create table auth.users (id uuid primary key, email text, raw_app_meta_data jsonb not null default '{}', encrypted_password text);
  create table auth.sessions (id uuid primary key, user_id uuid references auth.users(id));
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  create function auth.jwt() returns jsonb language sql stable as
    $$ select nullif(current_setting('request.jwt.claims', true), '')::jsonb $$;
  create schema storage;
  create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
  create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text);
  alter table storage.objects enable row level security;
`;

export const schemaSql = readFileSync(new URL("../../supabase/schema/sncs-schema-v12.sql", import.meta.url), "utf8");

export async function createTestDatabase(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(supabaseStandIns);
  await db.exec(schemaSql);
  return db;
}

/** Runs one query as a signed-in browser session for the given Auth user and session. */
export function asUser<T>(db: PGlite, userId: string, sql: string, values: unknown[] = [], sessionId = userId) {
  return db.transaction(async (tx) => {
    await tx.exec("set local role authenticated");
    await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [userId]);
    await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ session_id: sessionId })]);
    return tx.query<T>(sql, values);
  });
}
