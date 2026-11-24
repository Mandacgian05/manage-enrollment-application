/*
 * Author: Gian Mandac
 * Created Date: 20261119
 * The applicant's "What to bring" list, built from their form answers with the same
 * rules the Registrar's checklist, the status email and the printed form use.
 */
import { requirementsFor, type ApplicantProfile, type Requirement } from "./requirements";
import { schoolLevels, type Application } from "./form";

/** The same values the server stores (see server/enrollment-mapping.ts). */
export function applicantProfile(data: Application): ApplicantProfile | null {
  const level = Object.hasOwn(schoolLevels, data.level ?? "") ? schoolLevels[data.level] : undefined;
  if (!level || !data.gradeLevel || !data.studentStatus) return null;
  return {
    department: level.department,
    applicantType: data.studentStatus.toLowerCase(),
    gradeLevel: data.gradeLevel,
    religion: data.religion ?? "",
    lastSchoolName: data.previousSchool ?? "",
  };
}

export function checklistFor(data: Application): Requirement[] {
  const profile = applicantProfile(data);
  return profile ? requirementsFor(profile) : [];
}
