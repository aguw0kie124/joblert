import type { GmailMessage, GmailPart } from "../../src/gmail/parser.ts";

const encode = (text: string) => Buffer.from(text, "utf8").toString("base64url");

export const textPart = (text: string): GmailPart => ({ mimeType: "text/plain", body: { data: encode(text) } });
export const htmlPart = (html: string): GmailPart => ({ mimeType: "text/html", body: { data: encode(html) } });
export const multipart = (subtype: string, ...parts: GmailPart[]): GmailPart => ({
  mimeType: `multipart/${subtype}`,
  parts,
});

interface MessageOptions {
  from?: string;
  subject?: string;
  internalDate?: string | null;
  dateHeader?: string;
  body: GmailPart;
}

/** Builds a message shaped like the Gmail API's `users.messages.get` response with format=full. */
export function gmailMessage({
  from = "Acme Recruiting <no-reply@greenhouse.io>",
  subject = "Thank you for applying to Acme",
  internalDate = "1760000000000",
  dateHeader,
  body,
}: MessageOptions): GmailMessage {
  return {
    id: "msg-1",
    threadId: "thread-1",
    internalDate,
    payload: {
      ...body,
      headers: [
        { name: "From", value: from },
        { name: "Subject", value: subject },
        ...(dateHeader ? [{ name: "Date", value: dateHeader }] : []),
      ],
    },
  };
}
