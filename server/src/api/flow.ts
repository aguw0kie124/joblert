import { STAGE_RANK } from "../pipeline/stateMachine.ts";
import type { FlowNode, Status } from "../status.ts";

type Stage = keyof typeof STAGE_RANK;

export interface FlowApplication {
  id: string;
  status: Status;
}

/** A status change that still stands (not reverted). */
export interface FlowChange {
  applicationId: string;
  fromStatus: Status | null;
  toStatus: Status;
}

export interface FlowLink {
  from: FlowNode;
  to: FlowNode;
  count: number;
}

const STAGES = (Object.keys(STAGE_RANK) as Stage[]).sort((a, b) => STAGE_RANK[a] - STAGE_RANK[b]);
const NODES: FlowNode[] = [...STAGES, "rejected", "waiting"];

/** The stages one application went through, in funnel order. `changes` are its own, oldest first. */
function pathOf(status: Status, changes: FlowChange[]): FlowNode[] {
  // The furthest stage that still holds. A stage past it was a status someone corrected by hand.
  let furthest: Stage = "applied";
  if (status !== "rejected") furthest = status;
  else {
    const before = changes.findLast((c) => c.toStatus === "rejected")?.fromStatus;
    if (before && before !== "rejected") furthest = before;
  }

  const held = new Set<Status | null>(changes.flatMap((c) => [c.fromStatus, c.toStatus]));
  // Every application was applied to, including one first seen at a later stage.
  const passed = (stage: Stage) => held.has(stage) && STAGE_RANK[stage] < STAGE_RANK[furthest];
  const path: FlowNode[] = STAGES.filter((stage) => stage === "applied" || stage === furthest || passed(stage));

  if (status === "rejected") path.push("rejected");
  else if (status === "applied") path.push("waiting");
  return path;
}

/**
 * Counts how many applications moved between each pair of stages. Each application contributes one forward
 * path, so the result never loops, whatever order its statuses were set in. `changes` must be oldest first.
 */
export function buildFlow(applications: FlowApplication[], changes: FlowChange[]): FlowLink[] {
  const byApplication = new Map<string, FlowChange[]>();
  for (const change of changes) {
    const own = byApplication.get(change.applicationId);
    if (own) own.push(change);
    else byApplication.set(change.applicationId, [change]);
  }
  const counts = new Map<string, number>();
  for (const { id, status } of applications) {
    const path = pathOf(status, byApplication.get(id) ?? []);
    for (let i = 1; i < path.length; i++) {
      const key = `${path[i - 1]}>${path[i]}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  const links: FlowLink[] = [];
  for (const from of NODES) {
    for (const to of NODES) {
      const count = counts.get(`${from}>${to}`);
      if (count) links.push({ from, to, count });
    }
  }
  return links;
}
