/*
 * Author: Gian Mandac
 * Created Date: 20261116
 */
// @vitest-environment jsdom
import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, expect, it, vi } from "vitest";
import RegistrarApplicationDetail from "./RegistrarApplicationDetail.vue";

const client = vi.hoisted(() => ({ rpc: vi.fn(), functions: { invoke: vi.fn() } }));
vi.mock("@/lib/supabase", () => ({ getStaffSupabaseClient: () => client }));

const application = {
  applicationId: 1, referenceNo: "SNCS-TEST01", schoolYearStart: 2026, schoolYearEnd: 2027, department: "jhs", applicantType: "new",
  gradeLevel: "Grade 7", strandCode: null, paymentMode: "monthly", lastName: "Example", firstName: "Test",
  middleName: null, suffix: null, birthDate: "2013-01-15", sex: "female", birthPlace: "Taguig", religion: "Catholic",
  houseStreet: "12 Test Street", barangay: "Test Barangay", cityMunicipality: "Taguig", province: "Metro Manila", zipCode: "1630",
  primaryContactNumber: "09171234567", secondaryContactNumber: null, email: "test@example.com", parentEmail: null,
  lastSchoolName: "Example School", lastSchoolCityMunicipality: "Pasig", lastSchoolProvince: "Metro Manila",
  status: "pending", registrarRemarks: null, privacyConsentAt: "2026-11-14T00:00:00Z", submittedAt: "2026-11-14T00:00:00Z",
  guardians: [{ relationship: "guardian", lastName: "Example", firstName: "Guardian", middleName: null, suffix: null,
    occupation: null, contactNumber: "09171234567", email: null, messengerAccount: "example.guardian" }],
  documents: [], requirementChecks: { "psa-birth-certificate": true },
};

function mountDetail() {
  return mount(RegistrarApplicationDetail, { props: { reference: "SNCS-TEST01", hasPrevious: false, hasNext: true } });
}

afterEach(() => vi.resetAllMocks());

it("shows every submitted section and the dynamic checklist", async () => {
  client.rpc.mockResolvedValue({ data: structuredClone(application), error: null });
  const wrapper = mountDetail();
  try {
    await flushPromises();
    expect(client.rpc).toHaveBeenCalledWith("get_registrar_application", { p_reference: "SNCS-TEST01" });
    for (const text of ["Guardian Example", "12 Test Street, Test Barangay, Taguig, Metro Manila 1630", "Example School", "Pasig, Metro Manila", "example.guardian", "Good moral", "Baptismal certificate", "Former school’s name", "No documents were uploaded"]) {
      expect(wrapper.text().toLowerCase()).toContain(text.toLowerCase());
    }
    expect(wrapper.find<HTMLInputElement>('.checklist input[type="checkbox"]').element.checked).toBe(false);
    expect(wrapper.text()).toContain("1 of");
  } finally {
    wrapper.unmount();
  }
});

it("shows application not found for an unknown reference", async () => {
  client.rpc.mockResolvedValue({ data: null, error: null });
  const wrapper = mountDetail();
  try {
    await flushPromises();
    expect(wrapper.text()).toContain("Application not found");
  } finally {
    wrapper.unmount();
  }
});

it("saves a status only after confirmation and emails only after the Registrar confirms the preview", async () => {
  client.rpc.mockImplementation(async (name: string) => name === "get_registrar_application"
    ? { data: structuredClone(application), error: null }
    : { data: { status: "incomplete", registrarRemarks: "Bring the report card", changed: true }, error: null });
  client.functions.invoke.mockResolvedValue({ data: { success: true }, error: null });
  const wrapper = mountDetail();
  try {
    await flushPromises();
    await wrapper.get(".actions-card select").setValue("incomplete");
    await wrapper.get(".actions-card textarea").setValue("Bring the report card");
    await wrapper.findAll("button").find((button) => button.text() === "Save status")!.trigger("click");
    expect(client.rpc).not.toHaveBeenCalledWith("update_application_status", expect.anything());

    // Cancelling the confirmation leaves the status unchanged.
    await wrapper.findAll("button").find((button) => button.text() === "Cancel")!.trigger("click");
    expect(client.rpc).not.toHaveBeenCalledWith("update_application_status", expect.anything());

    await wrapper.findAll("button").find((button) => button.text() === "Save status")!.trigger("click");
    await wrapper.findAll("button").find((button) => button.text() === "Confirm")!.trigger("click");
    await flushPromises();
    expect(client.rpc).toHaveBeenCalledWith("update_application_status", {
      p_reference: "SNCS-TEST01", p_status: "incomplete", p_remarks: "Bring the report card",
    });
    expect(wrapper.emitted("updated")).toEqual([["SNCS-TEST01", "incomplete"]]);

    // No automatic email: the preview waits for the Registrar.
    expect(client.functions.invoke).not.toHaveBeenCalled();
    expect(wrapper.get(".email-preview").text()).toContain("Requirements still needed");
    expect(wrapper.get(".email-preview").text()).toContain("Bring the report card");
    await wrapper.findAll("button").find((button) => button.text() === "Confirm and send email")!.trigger("click");
    await flushPromises();
    expect(client.functions.invoke).toHaveBeenCalledWith("send-application-status-email", { body: { referenceNo: "SNCS-TEST01" } });
    expect(wrapper.text()).toContain("Status email sent to test@example.com");
  } finally {
    wrapper.unmount();
  }
});

it("lets the Registrar decline the status email", async () => {
  client.rpc.mockImplementation(async (name: string) => name === "get_registrar_application"
    ? { data: structuredClone(application), error: null }
    : { data: { status: "for_review", registrarRemarks: null, changed: true }, error: null });
  const wrapper = mountDetail();
  try {
    await flushPromises();
    await wrapper.findAll("button").find((button) => button.text() === "Save status")!.trigger("click");
    await wrapper.findAll("button").find((button) => button.text() === "Confirm")!.trigger("click");
    await flushPromises();
    await wrapper.findAll("button").find((button) => button.text() === "Don’t send")!.trigger("click");
    expect(wrapper.find(".email-preview").exists()).toBe(false);
    expect(client.functions.invoke).not.toHaveBeenCalled();
  } finally {
    wrapper.unmount();
  }
});

it("shows requirement progress and closes from the backdrop", async () => {
  client.rpc.mockResolvedValue({ data: structuredClone(application), error: null });
  const wrapper = mountDetail();
  try {
    await flushPromises();
    expect(wrapper.get("h2").text()).toBe("Test Example");
    const bar = wrapper.get('[role="progressbar"]');
    expect(bar.attributes("aria-valuenow")).toBe("1");
    await wrapper.get(".detail-scrim").trigger("click");
    expect(wrapper.emitted("close")).toHaveLength(1);
  } finally {
    wrapper.unmount();
  }
});
