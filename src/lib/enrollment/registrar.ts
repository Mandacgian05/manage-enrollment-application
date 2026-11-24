/*
 * Author: Gian Mandac
 * Created Date: 20261116
 * Registrar portal data access for Manage Enrollment Application. Every call goes
 * through a role-checked database function; the browser never reads the tables.
 */
import { getStaffSupabaseClient } from "@/lib/supabase";

export const applicationStatuses = {
  pending: "Pending",
  for_review: "For Review",
  complete: "Complete",
  incomplete: "Incomplete",
} as const;
export type ApplicationStatus = keyof typeof applicationStatuses;
/** Statuses a Registrar can set; Pending is the submission state only. */
export const processingStatuses = ["for_review", "complete", "incomplete"] as const;
export type ProcessingStatus = (typeof processingStatuses)[number];

export const searchPageSize = 25;

export type ApplicationSummary = {
  referenceNo: string;
  firstName: string;
  middleName: string | null;
  lastName: string;
  suffix: string | null;
  gradeLevel: string;
  status: ApplicationStatus;
  submittedAt: string;
};

export type ApplicationFilters = { query: string; status: ApplicationStatus | ""; from: string; to: string };

export type Guardian = {
  relationship: "father" | "mother" | "guardian";
  lastName: string;
  firstName: string;
  middleName: string | null;
  suffix: string | null;
  occupation: string | null;
  contactNumber: string | null;
  email: string | null;
  messengerAccount: string | null;
};
export type ApplicationDocument = { documentId: number; requirementKey: string; contentType: string; uploadedAt: string };

export type ApplicationDetail = {
  applicationId: number;
  referenceNo: string;
  schoolYearStart: number;
  schoolYearEnd: number;
  department: "preschool" | "grade_school" | "jhs" | "shs";
  applicantType: "new" | "old" | "returnee";
  gradeLevel: string;
  strandCode: string | null;
  paymentMode: string;
  lastName: string;
  firstName: string;
  middleName: string | null;
  suffix: string | null;
  birthDate: string;
  sex: string;
  birthPlace: string;
  religion: string;
  houseStreet: string;
  barangay: string;
  cityMunicipality: string;
  province: string;
  zipCode: string | null;
  primaryContactNumber: string;
  secondaryContactNumber: string | null;
  email: string;
  parentEmail: string | null;
  lastSchoolName: string | null;
  lastSchoolCityMunicipality: string | null;
  lastSchoolProvince: string | null;
  status: ApplicationStatus;
  registrarRemarks: string | null;
  privacyConsentAt: string;
  submittedAt: string;
  guardians: Guardian[];
  documents: ApplicationDocument[];
  requirementChecks: Record<string, boolean>;
};

/** First, middle, last name and suffix as one display name. */
export function personName(person: { firstName: string; middleName?: string | null; lastName: string; suffix?: string | null }): string {
  return [person.firstName, person.middleName, person.lastName, person.suffix].filter(Boolean).join(" ");
}

/** The split address fields as one line for display and printing. */
export function formatAddress(application: Pick<ApplicationDetail, "houseStreet" | "barangay" | "cityMunicipality" | "province" | "zipCode">): string {
  return [application.houseStreet, application.barangay, application.cityMunicipality,
    [application.province, application.zipCode].filter(Boolean).join(" ")].filter(Boolean).join(", ");
}

/** The former school's city/municipality and province, or an empty string. */
export function formatSchoolPlace(application: Pick<ApplicationDetail, "lastSchoolCityMunicipality" | "lastSchoolProvince">): string {
  return [application.lastSchoolCityMunicipality, application.lastSchoolProvince].filter(Boolean).join(", ");
}

export function schoolYearLabel(application: Pick<ApplicationDetail, "schoolYearStart" | "schoolYearEnd">): string {
  return `${application.schoolYearStart}-${application.schoolYearEnd}`;
}

/** Messenger accounts given for any parent or guardian. */
export function messengerAccounts(application: Pick<ApplicationDetail, "guardians">): string {
  return application.guardians.filter((guardian) => guardian.messengerAccount)
    .map((guardian) => guardian.messengerAccount).join(", ");
}

export class RegistrarError extends Error {
  constructor(public readonly kind: "access" | "not-found" | "invalid" | "unavailable", message: string) {
    super(message);
  }
}

function toRegistrarError(error: { code?: string; message?: string }): RegistrarError {
  if (error.code === "42501") return new RegistrarError("access", "Registrar access is required. Sign in again with a Registrar account.");
  if (error.code === "P0002") return new RegistrarError("not-found", "Application not found.");
  if (error.code === "22023") return new RegistrarError("invalid", error.message || "Check the entered values.");
  return new RegistrarError("unavailable", "The enrollment service is unavailable. Try again.");
}

export async function searchApplications(filters: ApplicationFilters, offset: number) {
  const { data, error } = await getStaffSupabaseClient().rpc("search_registrar_applications", {
    p_query: filters.query.trim() || null,
    p_status: filters.status || null,
    p_from: filters.from || null,
    p_to: filters.to || null,
    p_offset: offset,
  });
  if (error) throw toRegistrarError(error);
  const rows = (data ?? []) as ApplicationSummary[];
  return { rows: rows.slice(0, searchPageSize), hasMore: rows.length > searchPageSize };
}

export async function getApplication(reference: string): Promise<ApplicationDetail> {
  const { data, error } = await getStaffSupabaseClient().rpc("get_registrar_application", { p_reference: reference });
  if (error) throw toRegistrarError(error);
  if (!data) throw new RegistrarError("not-found", "Application not found.");
  return data as ApplicationDetail;
}

export async function setRequirement(reference: string, requirement: string, received: boolean) {
  const { error } = await getStaffSupabaseClient().rpc("set_application_requirement", {
    p_reference: reference, p_requirement: requirement, p_received: received,
  });
  if (error) throw toRegistrarError(error);
}

export async function updateStatus(reference: string, status: ProcessingStatus, remarks: string) {
  const { data, error } = await getStaffSupabaseClient().rpc("update_application_status", {
    p_reference: reference, p_status: status, p_remarks: remarks,
  });
  if (error) throw toRegistrarError(error);
  return data as { status: ApplicationStatus; registrarRemarks: string | null; changed: boolean };
}

/** Trigger Outbound Status Email: the edge function reads the recipient and status from the database. */
export async function sendStatusEmail(reference: string) {
  const { error } = await getStaffSupabaseClient().functions.invoke("send-application-status-email", {
    body: { referenceNo: reference },
  });
  if (error) throw new RegistrarError("unavailable", "The status email could not be sent.");
}

export type StatusCount = { count: number; more: boolean; oldest?: string };

/**
 * Live status counts for the Registrar dashboard. Uses the same role-checked search,
 * one call per status; a page holds 25 rows, so larger totals are shown as "25+".
 */
export async function countApplicationsByStatus(): Promise<Record<ApplicationStatus, StatusCount>> {
  const statuses = Object.keys(applicationStatuses) as ApplicationStatus[];
  const results = await Promise.all(statuses.map((status) =>
    searchApplications({ query: "", status, from: "", to: "" }, 0)));
  return Object.fromEntries(statuses.map((status, index) => {
    const { rows, hasMore } = results[index];
    // Rows are newest first, so the last row is the oldest on this page.
    return [status, { count: rows.length, more: hasMore, oldest: rows.at(-1)?.submittedAt }];
  })) as Record<ApplicationStatus, StatusCount>;
}
