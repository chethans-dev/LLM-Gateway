import type { Summary } from "../api/client";
import { formatCost, formatCount, formatLatency, formatPercent } from "../api/format";

/**
 * The five figures spec §18 asks for, plus p95.
 *
 * p95 is here because an average latency hides the tail, and the tail is what
 * people mean when they say the gateway feels slow. A dashboard showing only a
 * mean can look healthy through an incident.
 */
export function SummaryTiles({ summary }: { summary: Summary }) {
  const tiles = [
    {
      label: "Requests",
      value: formatCount(summary.total_requests),
      detail: summary.cached_requests > 0 ? `${formatCount(summary.cached_requests)} cached` : undefined,
    },
    {
      label: "Success rate",
      value: formatPercent(summary.success_rate),
      detail: `${formatCount(summary.failed_requests)} failed`,
    },
    {
      label: "Avg latency",
      value: formatLatency(summary.average_latency_ms),
      detail: `p95 ${formatLatency(summary.p95_latency_ms)}`,
    },
    {
      label: "Tokens",
      value: formatCount(summary.total_tokens),
      detail: `${formatCount(summary.input_tokens)} in / ${formatCount(summary.output_tokens)} out`,
    },
    {
      label: "Estimated cost",
      value: formatCost(summary.estimated_cost_usd),
      // Without this, a total computed from a third of the traffic looks
      // authoritative. Saying so is the difference between a number and a
      // trustworthy number.
      detail:
        summary.requests_without_cost > 0
          ? `${formatCount(summary.requests_without_cost)} unpriced`
          : "all requests priced",
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
      {tiles.map((tile) => (
        <div key={tile.label} className="rounded border border-slate-700 bg-slate-900 p-4">
          <div className="text-xs uppercase tracking-wide text-slate-400">{tile.label}</div>
          <div className="mt-1 font-mono text-2xl text-slate-100">{tile.value}</div>
          {tile.detail !== undefined && (
            <div className="mt-1 text-xs text-slate-500">{tile.detail}</div>
          )}
        </div>
      ))}
    </div>
  );
}
