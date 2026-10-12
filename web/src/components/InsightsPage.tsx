import type { FlowNode } from "@tracker/server/status";
import { STATUS_LABELS } from "@tracker/server/status";
import { sankey, sankeyLinkHorizontal } from "d3-sankey";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import type { FlowLink } from "../api.ts";
import { useFlow } from "../hooks.ts";
import { PlusIcon } from "./ui.tsx";

const NODE_LABELS: Record<FlowNode, string> = { ...STATUS_LABELS, waiting: "No reply yet" };

const HEIGHT = 340;
const NODE_WIDTH = 10;

/** The width of the element the returned ref is attached to, kept current as the window resizes. */
function useWidth() {
  // State, not useRef: the chart's container only exists once the data has loaded.
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry?.contentRect.width ?? 0)));
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return [setElement, width] as const;
}

function FlowChart({ links, width }: { links: FlowLink[]; width: number }) {
  const ids = [...new Set(links.flatMap((l) => [l.from, l.to]))];
  // d3-sankey writes positions onto the objects it is given, so it gets fresh ones on every render.
  const graph = sankey<{ id: FlowNode }, object>()
    .nodeId((node) => node.id)
    .nodeWidth(NODE_WIDTH)
    .nodePadding(28)
    .extent([
      [0, 6],
      [width, HEIGHT - 6],
    ])({
    nodes: ids.map((id) => ({ id })),
    links: links.map((l) => ({ source: l.from, target: l.to, value: l.count })),
  });
  const linkPath = sankeyLinkHorizontal();
  const summary = links.map((l) => `${l.count} from ${NODE_LABELS[l.from]} to ${NODE_LABELS[l.to]}`).join(", ");

  return (
    <svg className="flow" width={width} height={HEIGHT} role="img" aria-label={`Application flow: ${summary}.`}>
      {graph.links.map((link) => {
        const from = (link.source as { id: FlowNode }).id;
        const to = (link.target as { id: FlowNode }).id;
        return (
          <path
            key={`${from}-${to}`}
            className={`flow-link flow-${to}`}
            d={linkPath(link) ?? undefined}
            strokeWidth={Math.max(1, link.width ?? 0)}
          >
            <title>{`${NODE_LABELS[from]} → ${NODE_LABELS[to]}: ${link.value}`}</title>
          </path>
        );
      })}
      {graph.nodes.map((node) => {
        const x0 = node.x0 ?? 0;
        const x1 = node.x1 ?? 0;
        const y0 = node.y0 ?? 0;
        const y1 = node.y1 ?? 0;
        // Labels point inwards, so the first and last columns never run off the chart.
        const leftHalf = x0 < width / 2;
        const height = Math.max(1, y1 - y0);
        return (
          <g key={node.id}>
            <rect className={`flow-node flow-${node.id}`} x={x0} y={y0} width={x1 - x0} height={height} rx={2} />
            <text
              className="flow-label"
              x={leftHalf ? x1 + 8 : x0 - 8}
              y={(y0 + y1) / 2}
              dy="0.35em"
              textAnchor={leftHalf ? "start" : "end"}
            >
              {NODE_LABELS[node.id]} <tspan className="flow-count">{node.value}</tspan>
            </text>
          </g>
        );
      })}
    </svg>
  );
}

const percent = (part: number, whole: number) => `${Math.round((part / whole) * 100)}%`;

export function InsightsPage() {
  const flow = useFlow();
  const [chartRef, width] = useWidth();
  const total = flow.data?.total ?? 0;
  const links = flow.data?.links ?? [];
  const reached = (node: FlowNode) => links.filter((l) => l.to === node).reduce((sum, l) => sum + l.count, 0);
  const replies = total - reached("waiting");

  const stats = [
    { label: "Applications", value: total, note: null },
    { label: "Heard back", value: replies, note: percent(replies, total) },
    { label: "Interviews", value: reached("interview"), note: percent(reached("interview"), total) },
    { label: "Offers", value: reached("offer"), note: percent(reached("offer"), total) },
    { label: "Rejected", value: reached("rejected"), note: percent(reached("rejected"), total) },
  ];

  return (
    <div className="page">
      {flow.isError && <p className="table-note">Insights could not be loaded. Try again in a moment.</p>}
      {flow.data && total === 0 && (
        <div className="empty">
          <div>
            <h2>Nothing to chart yet</h2>
            <p>Once applications are tracked, this page shows how many reached each stage and where they ended.</p>
          </div>
          <Link to="/applications/new" className="btn">
            <PlusIcon size={14} />
            Add an application
          </Link>
        </div>
      )}
      {total > 0 && (
        <>
          <dl className="stats">
            {stats.map((s) => (
              <div key={s.label} className="stat">
                <dt>{s.label}</dt>
                <dd>
                  {s.value}
                  {s.note && <span className="stat-note">{s.note}</span>}
                </dd>
              </div>
            ))}
          </dl>
          <h2 className="section-title">Where applications went</h2>
          <div ref={chartRef} className="flow-wrap">
            {width > 0 && <FlowChart links={links} width={width} />}
          </div>
        </>
      )}
    </div>
  );
}
