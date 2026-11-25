/*
 * Sends one email through whichever provider is configured in the function's secrets.
 * - Brevo (BREVO_API_KEY): sends to any address once the sender email (EMAIL_FROM) is
 *   confirmed under Senders in Brevo. Used first when its key is set.
 * - Resend (RESEND_API_KEY): with its test sender onboarding@resend.dev it only delivers to
 *   the Resend account's own email; other recipients need a verified domain.
 * Keep this file free of imports so both Vite (tests) and Deno can load it.
 */

export type EmailSettings = { BREVO_API_KEY?: string; RESEND_API_KEY?: string; EMAIL_FROM?: string };
export type EmailMessage = { to: { email: string; name?: string }; subject: string; html: string };
export type EmailResult = { sent: true; provider: "brevo" | "resend" } | { sent: false; reason: "not_configured" | "rejected" };

const resendTestSender = "Sto. Niño Catholic School <onboarding@resend.dev>";

/** "Name <email@example.com>" or a bare address → its parts. */
export function parseSender(value: string): { name?: string; email: string } | null {
  const match = /^\s*(?:"?([^"<]*?)"?\s*<([^<>\s]+@[^<>\s]+)>|([^<>\s]+@[^<>\s]+))\s*$/.exec(value);
  if (!match) return null;
  const email = match[2] ?? match[3];
  const name = match[1]?.trim();
  return name ? { name, email } : { email };
}

export function emailProvider(settings: EmailSettings): "brevo" | "resend" | null {
  if (settings.BREVO_API_KEY && settings.EMAIL_FROM && parseSender(settings.EMAIL_FROM)) return "brevo";
  if (settings.RESEND_API_KEY) return "resend";
  return null;
}

export async function sendEmail(settings: EmailSettings, message: EmailMessage, send: typeof fetch = fetch): Promise<EmailResult> {
  try {
    return await deliver(settings, message, send);
  } catch {
    return { sent: false, reason: "rejected" }; // Provider unreachable: report it like a refusal.
  }
}

async function deliver(settings: EmailSettings, message: EmailMessage, send: typeof fetch): Promise<EmailResult> {
  const provider = emailProvider(settings);
  if (provider === "brevo") {
    const sender = parseSender(settings.EMAIL_FROM!)!;
    const res = await send("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", "api-key": settings.BREVO_API_KEY! },
      body: JSON.stringify({
        sender, to: [message.to.name ? message.to : { email: message.to.email }],
        subject: message.subject, htmlContent: message.html,
      }),
    });
    return res.ok ? { sent: true, provider } : { sent: false, reason: "rejected" };
  }
  if (provider === "resend") {
    const res = await send("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${settings.RESEND_API_KEY}` },
      body: JSON.stringify({ from: settings.EMAIL_FROM || resendTestSender, to: [message.to.email], subject: message.subject, html: message.html }),
    });
    return res.ok ? { sent: true, provider } : { sent: false, reason: "rejected" };
  }
  return { sent: false, reason: "not_configured" };
}
