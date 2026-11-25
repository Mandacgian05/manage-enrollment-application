import { describe, expect, it, vi } from "vitest";
import { emailProvider, parseSender, sendEmail } from "../../../supabase/functions/_shared/email";

const message = { to: { email: "parent@example.com", name: "Ana Reyes" }, subject: "Update", html: "<p>Hi</p>" };
const ok = () => vi.fn().mockResolvedValue({ ok: true });

describe("status email sending", () => {
  it("reads a sender written as a name and address, or a bare address", () => {
    expect(parseSender("Sto. Niño Catholic School <registrar.sncs@gmail.com>")).toEqual({ name: "Sto. Niño Catholic School", email: "registrar.sncs@gmail.com" });
    expect(parseSender("registrar.sncs@gmail.com")).toEqual({ email: "registrar.sncs@gmail.com" });
    expect(parseSender("not an email")).toBeNull();
  });

  it("uses Brevo when its key and a sender are set, and sends to any recipient", async () => {
    const send = ok();
    const result = await sendEmail({ BREVO_API_KEY: "brevo-key", RESEND_API_KEY: "resend-key", EMAIL_FROM: "SNCS Registrar <registrar.sncs@gmail.com>" }, message, send);
    expect(result).toEqual({ sent: true, provider: "brevo" });
    const [url, init] = send.mock.calls[0];
    expect(url).toBe("https://api.brevo.com/v3/smtp/email");
    expect(init.headers).toMatchObject({ "api-key": "brevo-key" });
    expect(JSON.parse(init.body)).toEqual({
      sender: { name: "SNCS Registrar", email: "registrar.sncs@gmail.com" },
      to: [{ email: "parent@example.com", name: "Ana Reyes" }], subject: "Update", htmlContent: "<p>Hi</p>",
    });
  });

  it("falls back to Resend, and reports missing settings or a refusal", async () => {
    const send = ok();
    expect(await sendEmail({ RESEND_API_KEY: "resend-key" }, message, send)).toEqual({ sent: true, provider: "resend" });
    expect(send.mock.calls[0][0]).toBe("https://api.resend.com/emails");
    expect(JSON.parse(send.mock.calls[0][1].body).from).toContain("onboarding@resend.dev");

    expect(emailProvider({ BREVO_API_KEY: "brevo-key" })).toBeNull();
    expect(await sendEmail({}, message, ok())).toEqual({ sent: false, reason: "not_configured" });
    expect(await sendEmail({ RESEND_API_KEY: "k" }, message, vi.fn().mockResolvedValue({ ok: false }))).toEqual({ sent: false, reason: "rejected" });
    expect(await sendEmail({ RESEND_API_KEY: "k" }, message, vi.fn().mockRejectedValue(new TypeError("offline")))).toEqual({ sent: false, reason: "rejected" });
  });
});
