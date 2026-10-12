import { describe, expect, test } from "vitest";
import { buildFlow, type FlowChange } from "../src/api/flow.ts";
import type { Status } from "../src/status.ts";

/** One application's status changes, oldest first, as `[from, to]` pairs. */
const flowOf = (status: Status, ...steps: [Status | null, Status][]) =>
  buildFlow(
    [{ id: "a", status }],
    steps.map(([fromStatus, toStatus]): FlowChange => ({ applicationId: "a", fromStatus, toStatus })),
  );

describe("one application's path", () => {
  test("an application nobody answered is waiting", () => {
    expect(flowOf("applied", [null, "applied"])).toEqual([{ from: "applied", to: "waiting", count: 1 }]);
  });

  test("each stage it passed becomes a link", () => {
    const steps: [Status | null, Status][] = [
      [null, "applied"],
      ["applied", "oa"],
      ["oa", "interview"],
      ["interview", "rejected"],
    ];
    expect(flowOf("rejected", ...steps)).toEqual([
      { from: "applied", to: "oa", count: 1 },
      { from: "oa", to: "interview", count: 1 },
      { from: "interview", to: "rejected", count: 1 },
    ]);
  });

  test("a skipped stage stays skipped", () => {
    expect(flowOf("interview", [null, "applied"], ["applied", "interview"])).toEqual([
      { from: "applied", to: "interview", count: 1 },
    ]);
  });

  test("an application first seen at a later stage still starts at applied", () => {
    expect(flowOf("rejected", [null, "rejected"])).toEqual([{ from: "applied", to: "rejected", count: 1 }]);
    expect(flowOf("offer", [null, "offer"])).toEqual([{ from: "applied", to: "offer", count: 1 }]);
  });

  test("a status corrected back by hand leaves no trace of the later stage", () => {
    expect(flowOf("oa", [null, "applied"], ["applied", "interview"], ["interview", "oa"])).toEqual([
      { from: "applied", to: "oa", count: 1 },
    ]);
    expect(flowOf("applied", [null, "applied"], ["applied", "rejected"], ["rejected", "applied"])).toEqual([
      { from: "applied", to: "waiting", count: 1 },
    ]);
  });

  test("a rejection follows the stage it replaced", () => {
    expect(flowOf("rejected", [null, "interview"], ["interview", "rejected"])).toEqual([
      { from: "applied", to: "interview", count: 1 },
      { from: "interview", to: "rejected", count: 1 },
    ]);
  });

  test("with no events at all, the current status is enough", () => {
    expect(flowOf("interview")).toEqual([{ from: "applied", to: "interview", count: 1 }]);
  });
});

test("applications are counted together, in funnel order", () => {
  const links = buildFlow(
    [
      { id: "a", status: "applied" },
      { id: "b", status: "applied" },
      { id: "c", status: "rejected" },
      { id: "d", status: "interview" },
      { id: "e", status: "rejected" },
    ],
    [
      { applicationId: "d", fromStatus: "applied", toStatus: "oa" },
      { applicationId: "d", fromStatus: "oa", toStatus: "interview" },
      { applicationId: "e", fromStatus: "applied", toStatus: "oa" },
      { applicationId: "e", fromStatus: "oa", toStatus: "rejected" },
    ],
  );

  expect(links).toEqual([
    { from: "applied", to: "oa", count: 2 },
    { from: "applied", to: "rejected", count: 1 },
    { from: "applied", to: "waiting", count: 2 },
    { from: "oa", to: "interview", count: 1 },
    { from: "oa", to: "rejected", count: 1 },
  ]);
});
