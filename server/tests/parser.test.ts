import { describe, expect, test } from "vitest";
import { cleanText, MAX_TEXT_CHARS, parseMessage, parseSender } from "../src/gmail/parser.ts";
import { gmailMessage, htmlPart, multipart, textPart } from "./helpers/gmail.ts";

describe("parseMessage", () => {
  test("reads headers, date, and a plain-text body", () => {
    const parsed = parseMessage(gmailMessage({ body: textPart("Hi Sam,\r\n\r\nWe received your application.\r\n") }));
    expect(parsed).toEqual({
      gmailMessageId: "msg-1",
      threadId: "thread-1",
      senderName: "Acme Recruiting",
      senderEmail: "no-reply@greenhouse.io",
      subject: "Thank you for applying to Acme",
      receivedAt: new Date(1760000000000),
      text: "Hi Sam,\n\nWe received your application.",
    });
  });

  test("prefers the plain-text alternative over HTML", () => {
    const body = multipart("alternative", textPart("Plain version"), htmlPart("<p>HTML version</p>"));
    expect(parseMessage(gmailMessage({ body })).text).toBe("Plain version");
  });

  test("converts an HTML-only message, dropping link targets, images, and styles", () => {
    const html = `
      <html><head><style>p { color: red; }</style></head><body>
        <p>Hi Sam,</p>
        <p>Please complete your <a href="https://click.example.com/track?id=abc123">HackerRank assessment</a> by Friday.</p>
        <img src="https://example.com/pixel.gif" alt="logo">
      </body></html>`;
    const { text } = parseMessage(gmailMessage({ body: htmlPart(html) }));
    expect(text).toBe("Hi Sam,\n\nPlease complete your HackerRank assessment by Friday.");
  });

  test("finds the body inside nested multipart and ignores attachments", () => {
    const attachment = { mimeType: "text/plain", filename: "notes.txt", body: { data: "aWdub3JlIG1l" } };
    const body = multipart("mixed", attachment, multipart("alternative", htmlPart("<p>Nested body</p>")));
    expect(parseMessage(gmailMessage({ body })).text).toBe("Nested body");
  });

  test("falls back to HTML when the plain part is empty", () => {
    const body = multipart("alternative", textPart("  \n"), htmlPart("<p>Only in HTML</p>"));
    expect(parseMessage(gmailMessage({ body })).text).toBe("Only in HTML");
  });

  test("falls back to the Date header when internalDate is missing", () => {
    const parsed = parseMessage(
      gmailMessage({ internalDate: null, dateHeader: "Mon, 05 Oct 2026 14:30:00 +0000", body: textPart("x") }),
    );
    expect(parsed.receivedAt.toISOString()).toBe("2026-10-05T14:30:00.000Z");
  });

  test("rejects a message with no usable date", () => {
    expect(() => parseMessage(gmailMessage({ internalDate: null, body: textPart("x") }))).toThrow(/no usable date/);
  });

  test("returns empty text for a message with no body", () => {
    expect(parseMessage(gmailMessage({ body: multipart("mixed") })).text).toBe("");
  });
});

describe("parseSender", () => {
  test.each([
    ['"Acme Recruiting" <Jobs@Acme.com>', "Acme Recruiting", "jobs@acme.com"],
    ["Jane Doe <jane@acme.com>", "Jane Doe", "jane@acme.com"],
    ["<jane@acme.com>", null, "jane@acme.com"],
    ["jane@acme.com", null, "jane@acme.com"],
  ])("%s", (from, name, email) => {
    expect(parseSender(from)).toEqual({ name, email });
  });
});

describe("cleanText", () => {
  test("cuts a quoted reply", () => {
    const text = [
      "Thursday at 2pm works for me.",
      "",
      "On Mon, Oct 5, 2026 at 9:14 AM Jane Doe <jane@acme.com> wrote:",
      "> Are you free this week for an interview?",
    ].join("\n");
    expect(cleanText(text)).toBe("Thursday at 2pm works for me.");
  });

  test("cuts a quote header that wraps onto a second line", () => {
    const text = "Sounds good.\n\nOn Mon, Oct 5, 2026 at 9:14 AM Jane Doe\n<jane@acme.com> wrote:\nOld text";
    expect(cleanText(text)).toBe("Sounds good.");
  });

  test("cuts an Outlook-style quoted message", () => {
    const text = "Confirming the interview.\n\nFrom: Jane Doe <jane@acme.com>\nSent: Monday, October 5, 2026\nOld text";
    expect(cleanText(text)).toBe("Confirming the interview.");
  });

  test("cuts a signature", () => {
    expect(cleanText("We'd like to move forward.\n\n-- \nJane Doe\nRecruiter, Acme")).toBe("We'd like to move forward.");
  });

  test("cuts a confidentiality footer", () => {
    const text =
      "Unfortunately we will not be moving forward.\n\nThis email and any attachments are confidential and intended solely for the addressee.";
    expect(cleanText(text)).toBe("Unfortunately we will not be moving forward.");
  });

  test("keeps the content when the marker is the first thing in the message", () => {
    const text = "---------- Forwarded message ----------\nFrom: Acme\nThanks for applying.";
    expect(cleanText(text)).toContain("Thanks for applying.");
  });

  test("does not treat an ordinary sentence starting with 'On' as a quote header", () => {
    const text = "On behalf of the team, thank you for applying.\n\nWe will be in touch.";
    expect(cleanText(text)).toBe(text);
  });

  test("normalizes invisible characters and blank runs", () => {
    expect(cleanText("Hello there​\n\n\n\n\nBye   ")).toBe("Hello there\n\nBye");
  });

  test("truncates long bodies", () => {
    expect(cleanText("a".repeat(MAX_TEXT_CHARS + 500))).toHaveLength(MAX_TEXT_CHARS);
  });
});
