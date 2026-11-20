/*
 * Author: Gian Mandac
 * Created Date: 20261119
 * Online requirement uploads: which requirements accept a file, the allowed file types
 * and size, and the content check the server runs on every uploaded file. Shared by the
 * enrollment form (browser) and the enrollment server so both apply the same rules.
 */
// Explicit .js paths so the Node server (ESM) can load this file as well as Vite.
import { requirementsFor, type ApplicantProfile, type Requirement } from "../../../supabase/functions/_shared/requirements.js";
import { schoolLevels, type Application } from "./form.js";

export const documentBucket = "application-documents";
export const maxDocumentBytes = 10 * 1024 * 1024;
/** Upload links and their tickets stop working after this time. */
export const uploadWindowMinutes = 30;

export const documentTypes = {
  "application/pdf": { extension: "pdf", label: "PDF", names: /\.pdf$/i },
  "image/jpeg": { extension: "jpg", label: "JPG", names: /\.jpe?g$/i },
  "image/png": { extension: "png", label: "PNG", names: /\.png$/i },
} as const;
export type DocumentContentType = keyof typeof documentTypes;

/**
 * Paper documents a family can photograph or scan. Physical items (ID photos, folders,
 * sealed recommendation envelopes) and the entrance exam are still handled onsite.
 */
export const uploadableRequirementKeys = new Set([
  "psa-birth-certificate", "report-card", "baptismal-certificate", "marriage-certificate",
  "good-moral", "esc-certificate", "ncae-result",
]);

export function isDocumentContentType(value: unknown): value is DocumentContentType {
  return typeof value === "string" && Object.hasOwn(documentTypes, value);
}

/** The same applicant profile the server stores (see server/enrollment-mapping.ts). */
export function applicantProfile(data: Application): ApplicantProfile | null {
  const level = schoolLevels[data.level ?? ""];
  if (!level || !data.gradeLevel || !data.studentStatus) return null;
  return { department: level.department, applicant_type: data.studentStatus.toLowerCase(), grade_level: data.gradeLevel };
}

/** Upload slots shown on the form, one per document-type requirement. */
export function uploadSlotsFor(data: Application): Requirement[] {
  const profile = applicantProfile(data);
  return profile ? requirementsFor(profile).filter((item) => uploadableRequirementKeys.has(item.key)) : [];
}

/** Quick check in the browser before uploading; the server checks the real contents. */
export function documentFileError(file: { name: string; size: number; type: string }): string {
  if (!file.size) return "This file is empty.";
  if (file.size > maxDocumentBytes) return "Files must be 10 MB or smaller.";
  if (!isDocumentContentType(file.type) || !documentTypes[file.type].names.test(file.name)) {
    return "Upload a PDF, JPG or PNG file.";
  }
  return "";
}

const pdfActiveContent = ["/JavaScript", "/Launch", "/EmbeddedFile", "/RichMedia", "/XFA", "/Encrypt"];

function includesBytes(haystack: Uint8Array, needle: string, from = 0): boolean {
  const bytes = [...needle].map((character) => character.charCodeAt(0));
  outer: for (let index = from; index <= haystack.length - bytes.length; index += 1) {
    for (let offset = 0; offset < bytes.length; offset += 1) {
      if (haystack[index + offset] !== bytes[offset]) continue outer;
    }
    return true;
  }
  return false;
}

/**
 * Server-side content check. The file must really be the declared type (by its first
 * bytes, not its name), end properly, and a PDF must not contain scripts, launch
 * actions, embedded files, interactive forms or passwords. Returns "" when acceptable.
 */
export function documentContentError(bytes: Uint8Array, contentType: DocumentContentType): string {
  if (!bytes.length) return "The file is empty.";
  if (bytes.length > maxDocumentBytes) return "The file is larger than 10 MB.";
  const tail = bytes.subarray(Math.max(0, bytes.length - 1024));

  if (contentType === "application/pdf") {
    if (!includesBytes(bytes.subarray(0, 1024), "%PDF-")) return "The file is not a valid PDF.";
    if (!includesBytes(tail, "%%EOF")) return "The PDF is incomplete or damaged.";
    for (const marker of pdfActiveContent) {
      if (includesBytes(bytes, marker)) {
        return marker === "/Encrypt"
          ? "Password-protected PDFs can't be accepted. Upload a copy without a password."
          : "This PDF contains scripts, forms or attachments and can't be accepted. Upload a scan or photo instead.";
      }
    }
    return "";
  }
  if (contentType === "image/jpeg") {
    const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    if (!jpeg) return "The file is not a valid JPG image.";
    for (let index = tail.length - 2; index >= 0; index -= 1) {
      if (tail[index] === 0xff && tail[index + 1] === 0xd9) return "";
    }
    return "The JPG image is incomplete or damaged.";
  }
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((value, index) => bytes[index] === value);
  if (!png) return "The file is not a valid PNG image.";
  if (!includesBytes(tail, "IEND")) return "The PNG image is incomplete or damaged.";
  return "";
}

export function formatFileSize(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
