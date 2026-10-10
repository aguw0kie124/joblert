import { convert } from "html-to-text";

// The subset of the Gmail API message resource (format=full) that the parser reads.
export interface GmailHeader {
  name?: string | null;
  value?: string | null;
}

export interface GmailPart {
  mimeType?: string | null;
  filename?: string | null;
  headers?: GmailHeader[] | null;
  body?: { data?: string | null } | null;
  parts?: GmailPart[] | null;
}

export interface GmailMessage {
  id: string;
  threadId: string;
  /** Epoch milliseconds, as a string. */
  internalDate?: string | null;
  payload?: GmailPart | null;
}

export interface ParsedEmail {
  gmailMessageId: string;
  threadId: string;
  senderName: string | null;
  senderEmail: string;
  subject: string;
  receivedAt: Date;
  /** Cleaned body text, capped at MAX_TEXT_CHARS. */
  text: string;
}

// Caps what one email can cost at the classifier.
export const MAX_TEXT_CHARS = 6000;

// Everything from the first of these onward is quoted history, a signature, or a legal footer.
const CUT_MARKERS = [
  /^On [\s\S]{0,300}?wrote:[ \t]*$/m,
  /^-{2,}[ \t]*(Original|Forwarded) message[ \t]*-{2,}[ \t]*$/im,
  /^From: .+\n(Sent|Date): .+$/m,
  /^-- ?$/m,
  /^_{10,}[ \t]*$/m,
  /^(This (e-?mail|message)|The information (contained )?in this (e-?mail|message))\b.{0,80}\b(confidential|intended (only|solely))/im,
];

function header(part: GmailPart, name: string): string {
  const found = part.headers?.find((h) => h.name?.toLowerCase() === name);
  return found?.value?.trim() ?? "";
}

export function parseSender(from: string): { name: string | null; email: string } {
  const match = from.match(/^\s*(.*?)\s*<([^<>]+)>\s*$/);
  if (!match) return { name: null, email: from.trim().toLowerCase() };
  const name = match[1]!.replace(/^"(.*)"$/, "$1").trim();
  return { name: name || null, email: match[2]!.trim().toLowerCase() };
}

function decodeBody(part: GmailPart): string {
  const data = part.body?.data;
  return data ? Buffer.from(data, "base64url").toString("utf8") : "";
}

/** Depth-first search for the first non-attachment part of the given type that has content. */
function findBody(part: GmailPart, mimeType: string): string {
  if (part.mimeType === mimeType && !part.filename) {
    const text = decodeBody(part);
    if (text.trim()) return text;
  }
  for (const child of part.parts ?? []) {
    const text = findBody(child, mimeType);
    if (text) return text;
  }
  return "";
}

function htmlToText(html: string): string {
  return convert(html, {
    wordwrap: false,
    selectors: [
      // Link targets are mostly long tracking URLs; the link text carries the meaning.
      { selector: "a", options: { ignoreHref: true } },
      { selector: "img", format: "skip" },
    ],
  });
}

export function cleanText(raw: string): string {
  let text = raw
    .replace(/\r\n?/g, "\n")
    .replace(/[​-‍﻿­]/g, "")
    .replace(/ /g, " ")
    .split("\n")
    .filter((line) => !line.startsWith(">"))
    .map((line) => line.trimEnd())
    .join("\n");

  const cutAt = Math.min(
    ...CUT_MARKERS.map((marker) => {
      const index = text.search(marker);
      return index === -1 ? Infinity : index;
    }),
  );
  // Keep the original when the marker is at the very top (a bare forward, for example).
  if (cutAt !== Infinity && text.slice(0, cutAt).trim()) text = text.slice(0, cutAt);

  return text
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, MAX_TEXT_CHARS);
}

export function parseMessage(message: GmailMessage): ParsedEmail {
  const payload = message.payload ?? {};
  const sender = parseSender(header(payload, "from"));

  const internalDate = Number(message.internalDate);
  const receivedAt = Number.isFinite(internalDate) && internalDate > 0 ? new Date(internalDate) : new Date(header(payload, "date"));
  if (Number.isNaN(receivedAt.getTime())) {
    throw new Error(`Message ${message.id} has no usable date`);
  }

  const plain = findBody(payload, "text/plain");
  const body = plain || htmlToText(findBody(payload, "text/html"));

  return {
    gmailMessageId: message.id,
    threadId: message.threadId,
    senderName: sender.name,
    senderEmail: sender.email,
    subject: header(payload, "subject"),
    receivedAt,
    text: cleanText(body),
  };
}
