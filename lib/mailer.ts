/**
 * Platform email: sign-in links and invitations only. This is VC OS talking
 * to its own users, not a firm talking to founders or LPs; anything a firm
 * sends goes through the approval outbox as a draft (principle 3).
 *
 * With RESEND_API_KEY set, mail goes through Resend. Otherwise it's printed
 * to the server log, which is what you want in development.
 */
export interface Mailer {
  send(msg: { to: string; subject: string; text: string }): Promise<void>;
}

export const consoleMailer: Mailer = {
  async send(m) {
    console.log(`\n[mail] to ${m.to}: ${m.subject}\n${m.text}\n`);
  },
};

export function resendMailer(apiKey: string, from: string): Mailer {
  return {
    async send(m) {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from, to: [m.to], subject: m.subject, text: m.text }),
      });
      if (!res.ok) throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 200)}`);
    },
  };
}

export function defaultMailer(): Mailer {
  const key = process.env.RESEND_API_KEY;
  return key ? resendMailer(key, process.env.MAIL_FROM ?? "VC OS <login@example.com>") : consoleMailer;
}
