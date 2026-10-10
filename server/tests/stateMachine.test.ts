import { describe, expect, test } from "vitest";
import { decideTransition, type Transition } from "../src/pipeline/stateMachine.ts";
import { EMAIL_KINDS, STATUSES, type EmailKind, type Status } from "../src/status.ts";

const threshold = 0.85;
const decide = (current: Status, kind: EmailKind, confidence = 0.95) =>
  decideTransition({ current, kind, confidence, threshold });

const change = (to: Status): Transition => ({ action: "change", to });
const record: Transition = { action: "record" };
const conflict: Transition = { action: "review", reason: "status_conflict" };

// Rows: current status. Columns: classified email kind.
const table: Record<Status, Record<EmailKind, Transition>> = {
  applied: {
    applied: record,
    oa: change("oa"),
    interview: change("interview"),
    offer: change("offer"),
    rejected: change("rejected"),
    other: record,
  },
  oa: {
    applied: record,
    oa: record,
    interview: change("interview"),
    offer: change("offer"),
    rejected: change("rejected"),
    other: record,
  },
  interview: {
    applied: record,
    oa: record,
    interview: record,
    offer: change("offer"),
    rejected: change("rejected"),
    other: record,
  },
  offer: {
    applied: record,
    oa: conflict,
    interview: conflict,
    offer: record,
    rejected: conflict,
    other: record,
  },
  rejected: {
    applied: record,
    oa: conflict,
    interview: conflict,
    offer: conflict,
    rejected: record,
    other: record,
  },
};

describe("decideTransition", () => {
  for (const current of STATUSES) {
    for (const kind of EMAIL_KINDS) {
      test(`${current} + ${kind} email`, () => {
        expect(decide(current, kind)).toEqual(table[current][kind]);
      });
    }
  }

  test("low confidence goes to review instead of changing status", () => {
    expect(decide("applied", "rejected", 0.6)).toEqual({ action: "review", reason: "low_confidence" });
    expect(decide("rejected", "interview", 0.6)).toEqual({ action: "review", reason: "low_confidence" });
  });

  test("confidence exactly at the threshold is applied", () => {
    expect(decide("applied", "oa", threshold)).toEqual(change("oa"));
  });

  test("low-confidence non-status mail is still only recorded", () => {
    expect(decide("interview", "other", 0.2)).toEqual(record);
  });
});
