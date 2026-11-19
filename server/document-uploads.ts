/*
 * Author: Gian Mandac
 * Created Date: 20261119
 * Online requirement uploads, server side.
 *
 * 1. With a valid submission (CAPTCHA, rate limit and form checks already passed) the
 *    applicant lists the requirements they want to upload. The server creates one
 *    one-time upload link per file into the private bucket, at a path it chooses, plus a
 *    signed ticket that expires after 30 minutes.
 * 2. The browser uploads each file straight to storage (up to 10 MB, no Vercel limit).
 * 3. The browser sends the tickets back. The server downloads each file, checks its real
 *    contents, then records it for the Registrar or deletes it.
 */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  documentContentError, documentTypes, isDocumentContentType, maxDocumentBytes, uploadSlotsFor, uploadWindowMinutes,
  type DocumentContentType,
} from '../src/lib/enrollment/documents.js';
import type { Application } from '../src/lib/enrollment/form.js';

export type DocumentRequest = { requirement: string; contentType: DocumentContentType; size: number };
export type UploadTicket = { requirement: string; path: string; token: string; contentType: DocumentContentType; ticket: string };
export type UploadResult = { requirement: string; ok: boolean; message?: string };
type TicketPayload = { a: string; r: string; p: string; t: DocumentContentType; e: number };

export interface DocumentStorage {
  applicationByReference(reference: string): Promise<{ id: string; status: string } | null>;
  applicationById(id: string): Promise<{ id: string; status: string } | null>;
  /** Returns the token for a one-time signed upload to this exact path. */
  createUploadUrl(path: string): Promise<string>;
  download(path: string): Promise<Uint8Array | null>;
  remove(paths: string[]): Promise<void>;
  /** Saves the record (one per requirement) and returns the path of any file it replaced. */
  record(input: { applicationId: string; requirement: string; path: string; contentType: DocumentContentType; size: number }): Promise<{ replacedPath: string | null }>;
}

const maxFilesPerApplication = 12;
const pathPattern = /^([0-9]{1,19})\/([a-z0-9-]{1,60})\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(pdf|jpg|png)$/;

// Upload Request Validation START
/** Validates the optional list of files the applicant wants to upload. */
export function parseDocumentRequests(raw: unknown, data: Application): { requests: DocumentRequest[]; error?: string } {
  if (raw === undefined || raw === null || raw === '') return { requests: [] };
  let list: unknown;
  try { list = typeof raw === 'string' ? JSON.parse(raw) : raw; }
  catch { return { requests: [], error: 'The list of documents could not be read.' }; }
  if (!Array.isArray(list) || list.length > maxFilesPerApplication) return { requests: [], error: 'The list of documents is not valid.' };
  const allowed = new Set(uploadSlotsFor(data).map((slot) => slot.key));
  const seen = new Set<string>();
  const requests: DocumentRequest[] = [];
  for (const item of list) {
    const value = item && typeof item === 'object' && !Array.isArray(item) ? item as Record<string, unknown> : {};
    const { requirement, contentType, size } = value;
    if (typeof requirement !== 'string' || !allowed.has(requirement) || seen.has(requirement)) {
      return { requests: [], error: 'One of the documents does not match the requirements for this application.' };
    }
    if (!isDocumentContentType(contentType)) return { requests: [], error: 'Documents must be PDF, JPG or PNG files.' };
    if (typeof size !== 'number' || !Number.isInteger(size) || size < 1 || size > maxDocumentBytes) {
      return { requests: [], error: 'Each document must be 10 MB or smaller.' };
    }
    seen.add(requirement);
    requests.push({ requirement, contentType, size });
  }
  return { requests };
}
// Upload Request Validation END

// Signed Tickets START
function signature(secret: string, body: string) {
  // Domain-separated from the IP hash that uses the same secret.
  return createHmac('sha256', secret).update(`document-upload\0${body}`).digest('base64url');
}

export function signTicket(secret: string, payload: TicketPayload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${signature(secret, body)}`;
}

export function verifyTicket(secret: string, ticket: unknown, now = Date.now()): TicketPayload | null {
  if (typeof ticket !== 'string' || ticket.length > 1024) return null;
  const [body, mac, extra] = ticket.split('.');
  if (!body || !mac || extra !== undefined) return null;
  const expected = Buffer.from(signature(secret, body));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  let payload: TicketPayload;
  try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); }
  catch { return null; }
  const match = typeof payload?.p === 'string' ? pathPattern.exec(payload.p) : null;
  if (!match || match[1] !== payload.a || match[2] !== payload.r || !isDocumentContentType(payload.t)
    || documentTypes[payload.t].extension !== match[3] || typeof payload.e !== 'number' || payload.e < now) return null;
  return payload;
}
// Signed Tickets END

// Issue Upload Links START
export async function issueUploads(storage: DocumentStorage, secret: string, reference: string, requests: DocumentRequest[], now = Date.now()): Promise<UploadTicket[]> {
  if (!requests.length) return [];
  const application = await storage.applicationByReference(reference);
  if (!application || application.status !== 'pending') return [];
  const expires = now + uploadWindowMinutes * 60_000;
  const tickets: UploadTicket[] = [];
  for (const request of requests) {
    // The server picks the path; nothing from the applicant (such as the file name) is used.
    const path = `${application.id}/${request.requirement}/${randomUUID()}.${documentTypes[request.contentType].extension}`;
    const token = await storage.createUploadUrl(path);
    tickets.push({
      requirement: request.requirement, path, token, contentType: request.contentType,
      ticket: signTicket(secret, { a: application.id, r: request.requirement, p: path, t: request.contentType, e: expires }),
    });
  }
  return tickets;
}
// Issue Upload Links END

// Verify Uploaded Files START
export async function completeUploads(storage: DocumentStorage, secret: string, rawTickets: unknown, now = Date.now()): Promise<UploadResult[] | null> {
  if (!Array.isArray(rawTickets) || !rawTickets.length || rawTickets.length > maxFilesPerApplication) return null;
  const results: UploadResult[] = [];
  for (const raw of rawTickets) {
    const ticket = verifyTicket(secret, raw, now);
    if (!ticket) { results.push({ requirement: 'unknown', ok: false, message: 'The upload link is not valid or has expired.' }); continue; }
    const fail = async (message: string) => {
      await storage.remove([ticket.p]);
      results.push({ requirement: ticket.r, ok: false, message });
    };
    const application = await storage.applicationById(ticket.a);
    if (!application || application.status !== 'pending') {
      await fail('The Registrar has already started reviewing this application. Bring this document to the Registrar’s Office.');
      continue;
    }
    const bytes = await storage.download(ticket.p);
    if (!bytes) { results.push({ requirement: ticket.r, ok: false, message: 'The file was not received. Try uploading it again.' }); continue; }
    const problem = documentContentError(bytes, ticket.t);
    if (problem) { await fail(problem); continue; }
    const { replacedPath } = await storage.record({
      applicationId: ticket.a, requirement: ticket.r, path: ticket.p, contentType: ticket.t, size: bytes.length,
    });
    if (replacedPath && replacedPath !== ticket.p) await storage.remove([replacedPath]);
    results.push({ requirement: ticket.r, ok: true });
  }
  return results;
}
// Verify Uploaded Files END
