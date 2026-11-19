import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, SubmissionError, type EnrollmentStore } from './app';
import { validApplication } from '../src/lib/enrollment/fixtures';
import { sectionsFor } from '../src/lib/enrollment/form';
import { ServiceError } from './service-error';

describe('enrollment HTTP API', () => {
  const store: EnrollmentStore = { period: vi.fn(), save: vi.fn() };
  const verify = vi.fn();
  const app = createApp(store, verify, { siteKey: 'public-key', ipHashSecret: 'a-long-test-secret', allowedOrigin: 'https://school.example' });
  const post = (data: Record<string, unknown> = { ...validApplication, periodId: '1', privacyConsent: true }, token = 'valid') => request(app).post('/api/enrollment/applications').field('application', JSON.stringify(data)).field('captchaToken', token).field('submissionId', randomUUID());
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(store.period).mockResolvedValue({ status: 'open', schoolYear: '2026-2027', periodId: '1' });
    vi.mocked(store.save).mockResolvedValue({ reference: 'SNCS-TEST', created: true });
    verify.mockResolvedValue(true);
  });
  it('returns public configuration without credentials', async () => {
    const response = await request(app).get('/api/enrollment/config');
    expect(response.body).toEqual({ status: 'open', schoolYear: '2026-2027', periodId: '1', siteKey: 'public-key', documentUploads: false });
    expect(response.headers['cache-control']).toBe('no-store');
  });
  it('persists validated Pending applications and returns only a receipt', async () => {
    const response = await post().expect(201);
    expect(response.body).toMatchObject({ status: 'Pending', reference: 'SNCS-TEST' });
    expect(response.body.message).toContain('Registrar');
    expect(store.save).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ surname: 'Example' }), ipHash: expect.stringMatching(/^[a-f0-9]{64}$/) }));
    expect(response.body.email).toBeUndefined();
  });
  it('blocks closed enrollment before CAPTCHA or persistence', async () => {
    vi.mocked(store.period).mockResolvedValue({ status: 'closed', schoolYear: '', periodId: null });
    await post().expect(403); expect(verify).not.toHaveBeenCalled(); expect(store.save).not.toHaveBeenCalled();
  });
  it('rejects forged fields and invalid optional files', async () => {
    const invalid = await post({ ...validApplication, periodId: '1', privacyConsent: true, email: 'bad' }).expect(422);
    expect(invalid.body.errors.email).toBeTruthy();
    await post().attach('attachment', Buffer.from('fake image'), { filename: 'fake.png', contentType: 'image/png' }).expect(422);
    expect(store.save).not.toHaveBeenCalled();
  });
  it.each(sectionsFor({ level: 'SHS', gradeLevel: 'Grade 11' }).flatMap(section => section.fields).filter(field => !field.readOnly))('rejects forged $key values before CAPTCHA or database access', async field => {
    const result = await post({ ...validApplication, level: 'SHS', gradeLevel: 'Grade 11', strand: '11-ACADEMIC', periodId: '1', privacyConsent: true, [field.key]: 'x'.repeat(field.maxLength! + 1) }).expect(422);
    expect(result.body.errors[field.key]).toBeTruthy();
    expect(verify).not.toHaveBeenCalled(); expect(store.save).not.toHaveBeenCalled();
  });
  it.each(['contact', 'fatherContact', 'motherContact', 'guardianContact'])('rejects invalid %s even when browser restrictions are bypassed', async key => {
    for (const value of ['091712345678', '08171234567', '0917123456', '+639171234567', '09171234567,09981234567']) {
      const result = await post({ ...validApplication, periodId: '1', privacyConsent: true, [key]: value }).expect(422);
      expect(result.body.errors[key]).toBeTruthy();
    }
    expect(verify).not.toHaveBeenCalled(); expect(store.save).not.toHaveBeenCalled();
  });
  it.each(sectionsFor({ level: 'SHS', gradeLevel: 'Grade 11' }).flatMap(section => section.fields).filter(field => field.required))('rejects missing required $key at the API', async field => {
    const result = await post({ ...validApplication, level: 'SHS', gradeLevel: 'Grade 11', strand: '11-ACADEMIC', periodId: '1', privacyConsent: true, [field.key]: '   ' }).expect(422);
    expect(result.body.errors[field.key]).toBeTruthy(); expect(store.save).not.toHaveBeenCalled();
  });
  it('rejects wrong JSON field types and recalculates a forged age before saving', async () => {
    const result = await post({ ...validApplication, periodId: '1', privacyConsent: true, parentEmail: ['hidden@example.com'], birthday: 20130115, guardianContact: { phone: '09171234567' } }).expect(422);
    expect(Object.keys(result.body.errors)).toEqual(expect.arrayContaining(['parentEmail', 'birthday', 'guardianContact']));
    await post({ ...validApplication, periodId: '1', privacyConsent: true, age: '999' }).expect(201);
    expect(store.save).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ age: expect.not.stringMatching(/^999$/) }) }));
  });
  it('rejects file uploads before CAPTCHA or database access', async () => {
    await post().attach('attachment', Buffer.from('%PDF-1.4\nexample'), { filename: 'document.pdf', contentType: 'application/pdf' }).expect(422);
    expect(verify).not.toHaveBeenCalled(); expect(store.save).not.toHaveBeenCalled();
  });
  it('rejects missing, failed and expired CAPTCHA without saving', async () => {
    await post(undefined, '').expect(422);
    verify.mockResolvedValue(false); await post().expect(422);
    expect(store.save).not.toHaveBeenCalled();
  });
  it('fails safely on provider or persistence outage', async () => {
    verify.mockRejectedValue(new Error('secret provider response'));
    expect((await post().expect(503)).text).not.toContain('secret');
    verify.mockResolvedValue(true); vi.mocked(store.save).mockRejectedValue(new Error('database secret'));
    expect((await post().expect(503)).body.reference).toBeUndefined();
  });
  it('logs only the failed stage and safe provider code, never applicant or provider details', async () => {
    const logger = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      verify.mockRejectedValue(new Error('private token and provider response'));
      await post().expect(503);
      expect(logger).toHaveBeenLastCalledWith('Enrollment service failure', { stage: 'captcha' });
      verify.mockResolvedValue(true);
      vi.mocked(store.save).mockRejectedValue(new ServiceError('private SQL and applicant details', 'PGRST202'));
      const response = await post().expect(503);
      expect(logger).toHaveBeenLastCalledWith('Enrollment service failure', { stage: 'save', providerCode: 'PGRST202' });
      expect(response.text).not.toContain('PGRST202');
      expect(JSON.stringify(logger.mock.calls)).not.toMatch(/private|Example|test-secret|token/);
      vi.mocked(store.save).mockRejectedValue(new ServiceError('private response', 'private-code-containing-data'));
      await post().expect(503);
      expect(logger).toHaveBeenLastCalledWith('Enrollment service failure', { stage: 'save' });
    } finally { logger.mockRestore(); }
  });
  it('maps atomic database rate limits and close races', async () => {
    vi.mocked(store.save).mockRejectedValue(new SubmissionError('rate_limit'));
    const result = await post().expect(429);
    expect(result.headers['retry-after']).toBe('3600');
    vi.mocked(store.save).mockRejectedValue(new SubmissionError('closed')); await post().expect(403);
  });
  it('returns the same receipt after a retry', async () => {
    vi.mocked(store.save).mockResolvedValue({ reference: 'SNCS-EXISTING', created: false });
    const response = await post().expect(200);
    expect(response.body.reference).toBe('SNCS-EXISTING');
  });
  it('does not trust spoofed forwarding headers or a foreign origin', async () => {
    await post().set('X-Forwarded-For', '203.0.113.99').expect(201);
    expect(verify.mock.calls[0][1]).not.toBe('203.0.113.99');
    await post().set('Origin', 'https://other.example').expect(403);
  });
  it('requires explicit privacy consent and rejects stale period IDs before saving', async () => {
    const result = await post({ ...validApplication, periodId: '1', privacyConsent: false }).expect(422);
    expect(result.body.errors.privacyConsent).toBeTruthy();
    await post({ ...validApplication, periodId: '2', privacyConsent: true }).expect(403);
    expect(store.save).not.toHaveBeenCalled();
  });
});

describe('online requirement uploads', () => {
  const storage = {
    applicationByReference: vi.fn(), applicationById: vi.fn(), createUploadUrl: vi.fn(),
    download: vi.fn(), remove: vi.fn(), record: vi.fn(),
  };
  const store: EnrollmentStore = { period: vi.fn(), save: vi.fn(), documents: storage };
  const verify = vi.fn();
  const app = createApp(store, verify, { siteKey: 'public-key', ipHashSecret: 'a-long-test-secret', allowedOrigin: 'https://school.example' });
  const submit = (documents?: unknown) => {
    const req = request(app).post('/api/enrollment/applications')
      .field('application', JSON.stringify({ ...validApplication, periodId: '1', privacyConsent: true }))
      .field('captchaToken', 'valid').field('submissionId', randomUUID());
    return documents === undefined ? req : req.field('documents', JSON.stringify(documents));
  };
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(store.period).mockResolvedValue({ status: 'open', schoolYear: '2026-2027', periodId: '1' });
    vi.mocked(store.save).mockResolvedValue({ reference: 'SNCS-TEST', created: true });
    verify.mockResolvedValue(true);
    storage.applicationByReference.mockResolvedValue({ id: '7', status: 'pending' });
    storage.createUploadUrl.mockResolvedValue('upload-token');
  });

  it('tells the form that uploads are on', async () => {
    expect((await request(app).get('/api/enrollment/config')).body.documentUploads).toBe(true);
  });

  it('returns upload links for listed requirements after saving', async () => {
    const response = await submit([{ requirement: 'report-card', contentType: 'application/pdf', size: 1000 }]).expect(201);
    expect(response.body.uploads).toEqual([expect.objectContaining({ requirement: 'report-card', token: 'upload-token', path: expect.stringMatching(/^7\/report-card\/[0-9a-f-]{36}\.pdf$/) })]);
    expect(response.body.uploadsUnavailable).toBe(false);
  });

  it('rejects an invalid document list before CAPTCHA or saving', async () => {
    const response = await submit([{ requirement: 'id-photos', contentType: 'image/png', size: 10 }]).expect(422);
    expect(response.body.errors.documents).toBeTruthy();
    expect(verify).not.toHaveBeenCalled(); expect(store.save).not.toHaveBeenCalled();
  });

  it('keeps the saved application when upload links fail', async () => {
    storage.createUploadUrl.mockRejectedValue(new Error('bucket missing'));
    const response = await submit([{ requirement: 'report-card', contentType: 'application/pdf', size: 1000 }]).expect(201);
    expect(response.body).toMatchObject({ reference: 'SNCS-TEST', uploads: [], uploadsUnavailable: true });
  });

  it('checks uploaded files only from this site and with a valid body', async () => {
    await request(app).post('/api/enrollment/documents').set('Origin', 'https://evil.example').send({ tickets: ['x'] }).expect(403);
    await request(app).post('/api/enrollment/documents').send({ tickets: 'x' }).expect(400);
    await request(app).post('/api/enrollment/documents').set('Content-Type', 'application/json').send('{"tickets":[' + '"x",'.repeat(5000) + '"x"]}').expect(400);
    const response = await request(app).post('/api/enrollment/documents').send({ tickets: ['forged.ticket'] }).expect(200);
    expect(response.body.results).toEqual([expect.objectContaining({ ok: false })]);
    expect(storage.download).not.toHaveBeenCalled();
  });
});

it('turns the document endpoint off when uploads are not enabled', async () => {
  const app = createApp({ period: vi.fn(), save: vi.fn() }, vi.fn(), { siteKey: 'k', ipHashSecret: 'a-long-test-secret', allowedOrigin: 'https://school.example' });
  await request(app).post('/api/enrollment/documents').send({ tickets: ['x'] }).expect(404);
});

