import { createClient } from '@supabase/supabase-js';
import { Pool } from 'pg';
import type { EnrollmentStore } from './app.js';
import { ServiceError } from './service-error.js';
import { saveEnrollment } from './enrollment-transaction.js';
import type { DocumentStorage } from './document-uploads.js';
import { documentBucket } from '../src/lib/enrollment/documents.js';

export function supabaseStore(url: string, serviceKey: string, databaseUrl?: string, sslCa?: string, options: { documentUploads?: boolean } = {}): EnrollmentStore {
  const db = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  let pool: Pool | undefined;
  async function connectDatabase() {
    if (!databaseUrl) throw new ServiceError('Missing server database connection', 'DBURL', 'database_connection');
    try {
      if (!pool) {
        const connection = new URL(databaseUrl);
        if (!['postgres:', 'postgresql:'].includes(connection.protocol)) throw new ServiceError('Invalid database connection format', 'DBFMT', 'database_connection');
        // URL SSL options must not replace certificate verification settings.
        for (const key of [...connection.searchParams.keys()]) if (key.startsWith('ssl')) connection.searchParams.delete(key);
        pool = new Pool({ connectionString: connection.toString(), ssl: { rejectUnauthorized: true, ...(sslCa ? { ca: sslCa } : {}) },
          max: 2, connectionTimeoutMillis: 10_000, query_timeout: 10_000, idleTimeoutMillis: 10_000, allowExitOnIdle: true });
        pool.on('error', () => console.error('Enrollment database idle connection failed'));
      }
      return await pool.connect();
    } catch (error) {
      if (error instanceof ServiceError) throw error;
      const code = error && typeof error === 'object' && 'code' in error ? error.code
        : error instanceof Error && error.message === 'Connection terminated due to connection timeout' ? 'CONNECTION_TIMEOUT' : undefined;
      throw new ServiceError('Database connection unavailable', code, 'database_connection');
    }
  }
  // Online Requirement Uploads START
  // Uses the server key: storage paths are chosen by the server, and browsers have no write access.
  const documents: DocumentStorage = {
    async applicationByReference(reference) {
      const { data, error } = await db.from('enrollment_applications').select('id::text,status').eq('reference_no', reference).maybeSingle();
      if (error) throw new ServiceError('Application lookup failed', error.code, 'documents');
      return data ? { id: String(data.id), status: String(data.status) } : null;
    },
    async applicationById(id) {
      const { data, error } = await db.from('enrollment_applications').select('id::text,status').eq('id', id).maybeSingle();
      if (error) throw new ServiceError('Application lookup failed', error.code, 'documents');
      return data ? { id: String(data.id), status: String(data.status) } : null;
    },
    async createUploadUrl(path) {
      const { data, error } = await db.storage.from(documentBucket).createSignedUploadUrl(path);
      if (error || !data?.token) throw new ServiceError('Upload link unavailable', undefined, 'documents');
      return data.token;
    },
    async download(path) {
      const { data, error } = await db.storage.from(documentBucket).download(path);
      if (error || !data) return null;
      return new Uint8Array(await data.arrayBuffer());
    },
    async remove(paths) {
      if (paths.length) await db.storage.from(documentBucket).remove(paths);
    },
    async record({ applicationId, requirement, path, contentType, size }) {
      const { data: previous, error: readError } = await db.from('application_documents').select('storage_path')
        .eq('application_id', applicationId).eq('document_type', requirement).maybeSingle();
      if (readError) throw new ServiceError('Document lookup failed', readError.code, 'documents');
      const { error } = await db.from('application_documents').upsert({
        application_id: applicationId, document_type: requirement, storage_path: path,
        content_type: contentType, file_size_bytes: size, uploaded_at: new Date().toISOString(),
      }, { onConflict: 'application_id,document_type' });
      if (error) throw new ServiceError('Document record failed', error.code, 'documents');
      return { replacedPath: previous?.storage_path ? String(previous.storage_path) : null };
    },
  };
  // Online Requirement Uploads END

  return {
    // Off until the 202611190001 migration is applied and DOCUMENT_UPLOADS=enabled is set.
    ...(options.documentUploads ? { documents } : {}),
    async period() {
      // Availability uses the existing Supabase API independently of the write connection.
      // A database connection failure must not prevent viewing or completing the form.
      const { data, error } = await db.from('enrollment_periods').select('id::text,status,school_year').eq('status', 'open').maybeSingle();
      if (error) throw new ServiceError('Enrollment configuration unavailable', error.code);
      if (!data) return { status: 'closed', schoolYear: '', periodId: null };
      return { status: data.status, schoolYear: data.school_year, periodId: String(data.id) };
    },
    async save(input) {
      const client = await connectDatabase();
      let failed = false;
      try { return await saveEnrollment(client, input); }
      catch (error) { failed = true; throw error; }
      finally { client.release(failed); }
    },
  };
}
