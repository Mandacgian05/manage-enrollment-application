/*
 * Author: Gian Mandac
 * Created Date: 20261119
 */
import { describe, expect, it } from "vitest";
import { documentContentError, documentFileError, maxDocumentBytes, uploadSlotsFor } from "./documents";

const bytes = (text: string) => new TextEncoder().encode(text);
const pdf = (body = "1 0 obj << /Type /Catalog >> endobj") => bytes(`%PDF-1.7\n${body}\ntrailer << >>\n%%EOF\n`);
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 0xff, 0xd9]);
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, ...bytes("IEND"), 0xae, 0x42, 0x60, 0x82]);

describe("upload slots", () => {
  it("offers only paper documents from the applicant's requirement list", () => {
    const keys = uploadSlotsFor({ level: "JHS", gradeLevel: "Grade 7", studentStatus: "New" }).map((slot) => slot.key);
    expect(keys).toEqual(["psa-birth-certificate", "report-card", "baptismal-certificate", "marriage-certificate", "good-moral"]);
    expect(keys).not.toContain("id-photos");
    expect(keys).not.toContain("entrance-exam");
  });

  it("follows the applicant type and grade", () => {
    expect(uploadSlotsFor({ level: "JHS", gradeLevel: "Grade 9", studentStatus: "Old" }).map((slot) => slot.key)).toEqual(["report-card"]);
    expect(uploadSlotsFor({ level: "SHS", gradeLevel: "Grade 11", studentStatus: "New" }).map((slot) => slot.key))
      .toEqual(["psa-birth-certificate", "report-card", "baptismal-certificate", "marriage-certificate", "good-moral", "esc-certificate", "ncae-result"]);
    expect(uploadSlotsFor({ level: "JHS", gradeLevel: "" })).toEqual([]);
  });
});

describe("browser file check", () => {
  it("accepts PDF, JPG and PNG up to 10 MB with a matching name", () => {
    expect(documentFileError({ name: "psa.pdf", size: 10, type: "application/pdf" })).toBe("");
    expect(documentFileError({ name: "card.JPEG", size: maxDocumentBytes, type: "image/jpeg" })).toBe("");
    expect(documentFileError({ name: "photo.png", size: maxDocumentBytes + 1, type: "image/png" })).toContain("10 MB");
    expect(documentFileError({ name: "empty.pdf", size: 0, type: "application/pdf" })).toContain("empty");
    expect(documentFileError({ name: "virus.exe", size: 10, type: "application/pdf" })).toContain("PDF, JPG or PNG");
    expect(documentFileError({ name: "form.docx", size: 10, type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" })).toContain("PDF, JPG or PNG");
  });
});

describe("server content check", () => {
  it("accepts real PDF, JPG and PNG files", () => {
    expect(documentContentError(pdf(), "application/pdf")).toBe("");
    expect(documentContentError(jpeg, "image/jpeg")).toBe("");
    expect(documentContentError(png, "image/png")).toBe("");
  });

  it("rejects files whose contents do not match the declared type", () => {
    expect(documentContentError(jpeg, "application/pdf")).toContain("not a valid PDF");
    expect(documentContentError(pdf(), "image/jpeg")).toContain("not a valid JPG");
    expect(documentContentError(bytes("MZ\x90\x00 fake executable"), "image/png")).toContain("not a valid PNG");
    expect(documentContentError(new Uint8Array(), "application/pdf")).toContain("empty");
  });

  it("rejects incomplete files", () => {
    expect(documentContentError(bytes("%PDF-1.7\n1 0 obj"), "application/pdf")).toContain("incomplete");
    expect(documentContentError(jpeg.subarray(0, 10), "image/jpeg")).toContain("incomplete");
    expect(documentContentError(png.subarray(0, 12), "image/png")).toContain("incomplete");
  });

  it("rejects PDFs with scripts, launch actions, attachments or passwords", () => {
    for (const marker of ["/JavaScript", "/Launch", "/EmbeddedFile", "/RichMedia", "/XFA"]) {
      expect(documentContentError(pdf(`1 0 obj << ${marker} (x) >> endobj`), "application/pdf")).toContain("can't be accepted");
    }
    expect(documentContentError(pdf("trailer << /Encrypt 5 0 R >>"), "application/pdf")).toContain("Password-protected");
  });

  it("rejects files over 10 MB", () => {
    const large = new Uint8Array(maxDocumentBytes + 1);
    large.set(pdf().subarray(0, 9));
    expect(documentContentError(large, "application/pdf")).toContain("10 MB");
  });
});
