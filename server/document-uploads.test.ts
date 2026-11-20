/*
 * Author: Gian Mandac
 * Created Date: 20261119
 */
import { describe, expect, it, vi } from 'vitest';
import { completeUploads, issueUploads, parseDocumentRequests, signTicket, verifyTicket, type DocumentStorage } from './document-uploads';

const secret = 'x'.repeat(40);
const grade7 = { level: 'JHS', gradeLevel: 'Grade 7', studentStatus: 'New' };
const pdf = new TextEncoder().encode('%PDF-1.7\n1 0 obj << >> endobj\n%%EOF\n');

function fakeStorage(overrides: Partial<DocumentStorage> = {}): DocumentStorage {
  return {
    applicationByReference: vi.fn(async () => ({ id: '42', status: 'pending' })),
    applicationById: vi.fn(async () => ({ id: '42', status: 'pending' })),
    createUploadUrl: vi.fn(async () => 'upload-token'),
    download: vi.fn(async () => pdf),
    remove: vi.fn(async () => undefined),
    record: vi.fn(async () => ({ replacedPath: null })),
    ...overrides,
  };
}

describe('upload requests', () => {
  it('accepts requirements from the applicant’s own list', () => {
    const result = parseDocumentRequests(JSON.stringify([{ requirement: 'good-moral', contentType: 'application/pdf', size: 2048 }]), grade7);
    expect(result).toEqual({ requests: [{ requirement: 'good-moral', contentType: 'application/pdf', size: 2048 }] });
    expect(parseDocumentRequests(undefined, grade7)).toEqual({ requests: [] });
  });

  it.each([
    ['an unknown requirement', [{ requirement: 'esc-certificate', contentType: 'application/pdf', size: 1 }]],
    ['a physical item', [{ requirement: 'id-photos', contentType: 'image/jpeg', size: 1 }]],
    ['a duplicate', [{ requirement: 'report-card', contentType: 'application/pdf', size: 1 }, { requirement: 'report-card', contentType: 'image/png', size: 1 }]],
    ['another file type', [{ requirement: 'report-card', contentType: 'application/zip', size: 1 }]],
    ['a file over 10 MB', [{ requirement: 'report-card', contentType: 'application/pdf', size: 10 * 1024 * 1024 + 1 }]],
    ['a negative size', [{ requirement: 'report-card', contentType: 'application/pdf', size: -1 }]],
    ['too many files', Array.from({ length: 13 }, () => ({ requirement: 'report-card', contentType: 'application/pdf', size: 1 }))],
  ])('rejects %s', (_case, list) => {
    expect(parseDocumentRequests(JSON.stringify(list), grade7).error).toBeTruthy();
  });

  it('rejects unreadable lists', () => {
    expect(parseDocumentRequests('{not json', grade7).error).toBeTruthy();
    expect(parseDocumentRequests('{"requirement":"report-card"}', grade7).error).toBeTruthy();
  });
});

describe('signed tickets', () => {
  const payload = { a: '42', r: 'report-card', p: '42/report-card/0f8fad5b-d9cb-469f-a165-70867728950e.pdf', t: 'application/pdf' as const, e: Date.now() + 60_000 };

  it('verifies an untouched, unexpired ticket', () => {
    expect(verifyTicket(secret, signTicket(secret, payload))).toEqual(payload);
  });

  it('rejects tampered, expired, mismatched or foreign tickets', () => {
    const ticket = signTicket(secret, payload);
    const [body, mac] = ticket.split('.');
    const forged = Buffer.from(JSON.stringify({ ...payload, a: '43' })).toString('base64url');
    expect(verifyTicket(secret, `${forged}.${mac}`)).toBeNull();
    expect(verifyTicket(secret, `${body}.${mac.slice(0, -2)}xx`)).toBeNull();
    expect(verifyTicket('y'.repeat(40), ticket)).toBeNull();
    expect(verifyTicket(secret, signTicket(secret, { ...payload, e: Date.now() - 1 }))).toBeNull();
    expect(verifyTicket(secret, signTicket(secret, { ...payload, p: '43/report-card/0f8fad5b-d9cb-469f-a165-70867728950e.pdf' }))).toBeNull();
    expect(verifyTicket(secret, signTicket(secret, { ...payload, p: '42/report-card/../../secret.pdf' }))).toBeNull();
    expect(verifyTicket(secret, signTicket(secret, { ...payload, t: 'image/png' }))).toBeNull();
    expect(verifyTicket(secret, 'not-a-ticket')).toBeNull();
  });
});

describe('issuing upload links', () => {
  it('creates a server-chosen path and ticket for each file', async () => {
    const storage = fakeStorage();
    const tickets = await issueUploads(storage, secret, 'SNCS-REF', [{ requirement: 'report-card', contentType: 'image/jpeg', size: 10 }]);
    expect(tickets).toHaveLength(1);
    expect(tickets[0].path).toMatch(/^42\/report-card\/[0-9a-f-]{36}\.jpg$/);
    expect(tickets[0].token).toBe('upload-token');
    expect(verifyTicket(secret, tickets[0].ticket)?.p).toBe(tickets[0].path);
  });

  it('issues nothing once the Registrar has started reviewing', async () => {
    const storage = fakeStorage({ applicationByReference: vi.fn(async () => ({ id: '42', status: 'for_review' })) });
    expect(await issueUploads(storage, secret, 'SNCS-REF', [{ requirement: 'report-card', contentType: 'image/jpeg', size: 10 }])).toEqual([]);
    expect(storage.createUploadUrl).not.toHaveBeenCalled();
  });
});

describe('checking uploaded files', () => {
  const ticketFor = (extra: Partial<{ a: string; e: number }> = {}) => signTicket(secret, {
    a: '42', r: 'report-card', p: '42/report-card/0f8fad5b-d9cb-469f-a165-70867728950e.pdf', t: 'application/pdf', e: Date.now() + 60_000, ...extra,
  });

  it('records a valid file and deletes the one it replaces', async () => {
    const storage = fakeStorage({ record: vi.fn(async () => ({ replacedPath: '42/report-card/11111111-1111-4111-8111-111111111111.pdf' })) });
    expect(await completeUploads(storage, secret, [ticketFor()])).toEqual([{ requirement: 'report-card', ok: true }]);
    expect(storage.record).toHaveBeenCalledWith(expect.objectContaining({ applicationId: '42', requirement: 'report-card', size: pdf.length }));
    expect(storage.remove).toHaveBeenCalledWith(['42/report-card/11111111-1111-4111-8111-111111111111.pdf']);
  });

  it('deletes a file whose contents are not allowed', async () => {
    const storage = fakeStorage({ download: vi.fn(async () => new TextEncoder().encode('MZ executable')) });
    const [result] = (await completeUploads(storage, secret, [ticketFor()]))!;
    expect(result.ok).toBe(false);
    expect(storage.remove).toHaveBeenCalledWith(['42/report-card/0f8fad5b-d9cb-469f-a165-70867728950e.pdf']);
    expect(storage.record).not.toHaveBeenCalled();
  });

  it('refuses expired or forged tickets without touching storage', async () => {
    const storage = fakeStorage();
    const results = await completeUploads(storage, secret, [ticketFor({ e: Date.now() - 1 }), 'forged.ticket']);
    expect(results?.every((item) => !item.ok)).toBe(true);
    expect(storage.download).not.toHaveBeenCalled();
    expect(storage.remove).not.toHaveBeenCalled();
  });

  it('refuses files once the application is under review', async () => {
    const storage = fakeStorage({ applicationById: vi.fn(async () => ({ id: '42', status: 'complete' })) });
    const [result] = (await completeUploads(storage, secret, [ticketFor()]))!;
    expect(result.ok).toBe(false);
    expect(storage.remove).toHaveBeenCalled();
    expect(storage.record).not.toHaveBeenCalled();
  });

  it('rejects malformed requests', async () => {
    expect(await completeUploads(fakeStorage(), secret, 'ticket')).toBeNull();
    expect(await completeUploads(fakeStorage(), secret, [])).toBeNull();
    expect(await completeUploads(fakeStorage(), secret, Array.from({ length: 13 }, () => ticketFor()))).toBeNull();
  });
});
