# Online requirement uploads

| | |
|---|---|
| **Related backlog item** | PB-12 enrollment form and PB-09 / US-10 ("open or download attachments through protected access") |
| **Author** | Gian Mandac, Nov 19, 2026 |
| **Status** | Built in the fork, **switched off**. The database migration is **not applied**: it waits for team approval |

Families can upload a scan or photo of each paper requirement with their application.
Uploading is **optional**: they can still bring the documents to the Registrar's Office,
and the originals are always checked in person before the Registrar ticks the checklist.

## How it works

| Step | Who | What happens |
|---|---|---|
| 1 | Applicant | The form shows one optional upload slot for each paper document in their requirement list (from grade level and applicant type). PDF, JPG or PNG, up to 10 MB each |
| 2 | Applicant | Reviews the list of chosen files and submits as usual (consent, CAPTCHA) |
| 3 | Server | Saves the application first. Then, for each listed file, creates a **one-time upload link** to a server-chosen path in a **private** bucket, plus a signed ticket valid for 30 minutes |
| 4 | Browser | Uploads each file straight to storage (so the 4.5 MB Vercel limit does not apply) |
| 5 | Server | Downloads each uploaded file and checks its real contents; records it for the Registrar, or deletes it and explains why |
| 6 | Applicant | Sees which documents were received and which to bring in person |
| 7 | Registrar | Sees each file beside its checklist item and in "Attached documents"; **Open** or **Download** uses a link that works for 60 seconds, and each opening is written to the audit log |

Which requirements accept uploads: PSA birth certificate, report card, baptismal
certificate, parents' marriage certificate, good moral certificate, ESC certificate and
NCAE result. Physical items (ID photos, folders, sealed recommendation envelopes) and the
entrance exam stay onsite.

## Safeguards

| Risk | Protection |
|---|---|
| Wrong or dangerous file types | Browser check; bucket only accepts PDF/JPG/PNG up to 10 MB; the server reads the file's first bytes (not its name) and its ending, and deletes anything else (for example an `.exe` renamed to `.pdf`) |
| Harmful PDFs | PDFs containing scripts (`/JavaScript`), launch actions, embedded files, rich media, interactive (XFA) forms or passwords are rejected; families are asked to upload a scan or photo instead |
| Uploading to someone else's application or path | The server chooses every path (`<application id>/<requirement>/<random id>.<ext>`); file names from families are never used; tickets are signed (HMAC) and tied to one application, requirement, path and file type |
| Replaying old links | Upload links are one-time; tickets expire after 30 minutes; nothing is accepted once the Registrar has moved the application past Pending |
| Public access | The bucket is private and has no public URLs; only an active Registrar can read it (storage policy); no browser can write, change or delete files |
| Abuse | Uploads are only offered after a valid submission (CAPTCHA, 5-per-hour limit); at most one file per requirement, 12 files per application |
| Privacy | Files are personal data: stored privately, opened only through audited 60-second links, consent already covers "documents I provide" |
| Failure | If links cannot be created, the application is still saved and the family is told to bring documents in person |

## Files

| File | Purpose |
|---|---|
| `supabase/migrations/202611190001_application_document_uploads.sql` | Private bucket, document columns and checks, one file per requirement, Registrar read policy, `record_document_access()`, updated `get_registrar_application()` |
| `supabase/rollback/202611190001_application_document_uploads_rollback.sql` | Undo |
| `src/lib/enrollment/documents.ts` | Shared rules: upload slots, file types and size, content check |
| `server/document-uploads.ts` | Upload links, signed tickets, file verification |
| `server/app.ts`, `server/supabase.ts`, `api/enrollment/documents.ts` | API wiring: `POST /api/enrollment/applications` (optional `documents` list), `POST /api/enrollment/documents` (check uploads) |
| `src/views/EnrollmentView.vue` | Upload slots, review list, upload progress and results |
| `src/lib/enrollment/registrar.ts`, `src/components/RegistrarApplicationDetail.vue` | Open and Download for the Registrar |

## Turning it on (after team approval)
1. Apply the migration `202611190001_application_document_uploads.sql` to Supabase.
2. In Vercel, add the environment variable `DOCUMENT_UPLOADS` = `enabled` (Production) and
   redeploy. Without it the form shows no upload slots and the API ignores document lists.
3. Test with a dummy application: upload a PDF and a photo, try a renamed `.exe`, then open
   the files as the Registrar and check the audit log entry `application.document_view`.

To turn it off again, remove `DOCUMENT_UPLOADS` and redeploy. Files already uploaded stay
private and readable by the Registrar.

## Tests
`pnpm test`: 27 files, 328 tests. New or extended:

- `src/lib/enrollment/documents.test.ts`: upload slots, browser file check, content check (fake types, damaged files, active PDF content, passwords, size).
- `server/document-uploads.test.ts`: request validation, signed tickets (tampering, expiry, other paths), link issuing, verification, deletion of rejected files.
- `server/app.test.ts`: API with uploads on and off, invalid lists blocked before CAPTCHA, saving still works if links fail, origin and body-size limits.
- `server/admin-auth-migration.test.ts`: migration on a test database: private bucket, record checks, one per requirement, Registrar-only file access, audit entry, no browser writes.
- `src/views/EnrollmentUploads.test.ts`, `src/components/RegistrarApplicationDetail.test.ts`: form slots, uploads and results; Registrar opening a file.

## Known limits
- If a family closes the page between uploading and the server check, the file stays in
  the private bucket but is not linked to the application (the Registrar does not see it).
  These can be cleared from the Supabase dashboard; an automatic clean-up can be added later.
- The PDF check looks for risky markers in the file; content hidden inside compressed parts
  cannot be fully inspected. The Registrar should open PDFs in the browser's viewer and
  always compare them with the originals.
- Storage use counts toward the Supabase plan (free plan: 1 GB).
