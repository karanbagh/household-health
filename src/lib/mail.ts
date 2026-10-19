import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import * as oidc from "openid-client";
import { z } from "zod";
import { config } from "../config.js";
import { googleConfiguration, verifiedGoogleClaims, type GoogleTransaction } from "./google.js";

export class MailError extends Error {
  constructor(message: string, readonly statusCode = 503, readonly uncertain = false) { super(message); }
}
export interface MailMessage { from: string; to: string; subject: string; text: string; calendar?: string }
export interface GmailProvider {
  authorize(transaction: GoogleTransaction): Promise<string>;
  callback(url: URL, transaction: GoogleTransaction): Promise<{ email: string; refreshToken: string }>;
  send(refreshToken: string, message: MailMessage): Promise<string>;
}
const SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
export function mailReady(): boolean {
  return Boolean(config.google.clientId && config.google.clientSecret && encryptionKey(false));
}
function encryptionKey(required = true): Buffer | null {
  const key = Buffer.from(config.mail.encryptionKey, "base64");
  if (key.length === 32 && key.toString("base64") === config.mail.encryptionKey) return key;
  if (required) throw new MailError("Gmail setup requires MAIL_ENCRYPTION_KEY to be configured by the app administrator.");
  return null;
}
export function encryptRefreshToken(value: string, householdId: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey()!, iv);
  cipher.setAAD(Buffer.from(householdId));
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".");
}
export function decryptRefreshToken(value: string, householdId: string): string {
  try {
    const [version, iv, tag, encrypted] = value.split(".");
    if (version !== "v1" || !iv || !tag || !encrypted) throw new Error("Invalid encrypted token");
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey()!, Buffer.from(iv, "base64url"));
    decipher.setAAD(Buffer.from(householdId));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64url")), decipher.final()]).toString("utf8");
  } catch { throw new MailError("The Gmail connection cannot be read. Ask the owner to reconnect Gmail."); }
}
const base64Lines = (value: string) => Buffer.from(value).toString("base64").match(/.{1,76}/g)?.join("\r\n") ?? "";
function subjectHeader(value: string): string {
  const chunks: string[] = []; let chunk = "";
  for (const character of value.replace(/[\r\n]/g, " ")) {
    if (Buffer.byteLength(chunk + character) > 42) { chunks.push(chunk); chunk = ""; }
    chunk += character;
  }
  if (chunk) chunks.push(chunk);
  return chunks.map(part => `=?UTF-8?B?${Buffer.from(part).toString("base64")}?=`).join("\r\n ");
}
export function mimeMessage(message: MailMessage): string {
  const email = z.email().max(254);
  const from = email.parse(message.from), to = email.parse(message.to);
  const headers = [`From: ${from}`, `To: ${to}`, `Subject: ${subjectHeader(message.subject)}`, "MIME-Version: 1.0"];
  if (!message.calendar) return [...headers, 'Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: base64", "", base64Lines(message.text), ""].join("\r\n");
  const boundary = `hh_${randomBytes(18).toString("hex")}`;
  return [...headers, `Content-Type: multipart/mixed; boundary="${boundary}"`, "", `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: base64", "", base64Lines(message.text),
    `--${boundary}`, 'Content-Type: text/calendar; charset="UTF-8"; method=REQUEST; name="appointment.ics"',
    'Content-Disposition: attachment; filename="appointment.ics"', "Content-Transfer-Encoding: base64", "", base64Lines(message.calendar), `--${boundary}--`, ""].join("\r\n");
}
export const gmailProvider: GmailProvider = {
  async authorize(transaction) {
    return oidc.buildAuthorizationUrl(await googleConfiguration(), {
      redirect_uri: config.google.origin + "/api/email/gmail/callback",
      scope: `openid email ${SEND_SCOPE}`, access_type: "offline", prompt: "consent select_account",
      state: transaction.state, nonce: transaction.nonce,
      code_challenge: await oidc.calculatePKCECodeChallenge(transaction.verifier), code_challenge_method: "S256",
    }).href;
  },
  async callback(url, transaction) {
    const tokens = await oidc.authorizationCodeGrant(await googleConfiguration(), url, {
      pkceCodeVerifier: transaction.verifier, expectedState: transaction.state, expectedNonce: transaction.nonce, idTokenExpected: true,
    });
    const claims = tokens.claims();
    if (!claims || !tokens.refresh_token || !tokens.scope?.split(" ").includes(SEND_SCOPE)) throw new MailError("Google did not grant offline Gmail sending. Reconnect Gmail and approve sending access.");
    return { email: verifiedGoogleClaims(claims).email, refreshToken: tokens.refresh_token };
  },
  async send(refreshToken, message) {
    let tokenResponse: Response;
    try {
      tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, signal: AbortSignal.timeout(15000),
        body: new URLSearchParams({ client_id: config.google.clientId, client_secret: config.google.clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" }),
      });
    } catch { throw new MailError("Could not connect to Gmail. Try again later."); }
    if (!tokenResponse.ok) throw new MailError("Gmail authorization failed. Ask the owner to reconnect Gmail.");
    const token = z.object({ access_token: z.string().min(1) }).safeParse(await tokenResponse.json().catch(() => null));
    if (!token.success) throw new MailError("Gmail did not return an access token. Reconnect Gmail.");
    let sent: Response;
    try {
      sent = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
        method: "POST", signal: AbortSignal.timeout(20000),
        headers: { authorization: `Bearer ${token.data.access_token}`, "content-type": "application/json" },
        body: JSON.stringify({ raw: Buffer.from(mimeMessage(message)).toString("base64url") }),
      });
    } catch { throw new MailError("Gmail did not confirm delivery. Check Gmail Sent before sending again.", 502, true); }
    if (!sent.ok) throw new MailError("Gmail rejected the message. Check Gmail API access and sending limits, then try again.", 502, sent.status >= 500);
    const parsed = z.object({ id: z.string().min(1) }).safeParse(await sent.json().catch(() => null));
    if (!parsed.success) throw new MailError("Gmail did not confirm delivery. Check Gmail Sent before sending again.", 502, true);
    return parsed.data.id;
  },
};
