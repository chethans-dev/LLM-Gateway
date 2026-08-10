import type { ProviderStats } from "../api/client";
import { formatCost, formatCount, formatLatency, formatPercent } from "../api/format";

/**
 * Per-provider breakdown (spec §18).
 *
 * Providers appear because they served traffic, not from a hardcoded list of
 * OpenAI/Gemini/Anthropic/Ollama — a table that lists providers you never
 * configured is noise, and one that omits a provider added later is a bug.
 */
export function ProviderTable({ providers }: { providers: readonly ProviderStats[] }) {
  if (providers.length === 0) {
    return <EmptyState />;
  }

  return (
    <div className="overflow-x-auto rounded border border-slate-700">
      <table className="w-full text-left text-sm">
        <thead className="bg-slate-800 text-xs uppercase tracking-wide text-slate-400">
          <tr>
            <th className="px-3 py-2">Provider</th>
            <th className="px-3 py-2 text-right">Requests</th>
            <th className="px-3 py-2 text-right">Success</th>
            <th className="px-3 py-2 text-right">Avg latency</th>
            <th className="px-3 py-2 text-right">Tokens</th>
            <th className="px-3 py-2 text-right">Est. cost</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-800">
          {providers.map((row) => (
            <tr key={row.provider} className="bg-slate-900">
              <td className="px-3 py-2 font-mono text-slate-200">
                {/* Requests that failed before a provider was chosen. */}
                {row.provider === "unrouted" ? (
                  <span className="text-slate-500">unrouted</span>
                ) : (
                  row.provider
                )}
              </td>
              <td className="px-3 py-2 text-right font-mono">{formatCount(row.requests)}</td>
              <td className="px-3 py-2 text-right font-mono">
                {formatPercent(row.requests === 0 ? null : row.successful_requests / row.requests)}
              </td>
              <td className="px-3 py-2 text-right font-mono">
                {formatLatency(row.average_latency_ms)}
              </td>
              <td className="px-3 py-2 text-right font-mono">{formatCount(row.total_tokens)}</td>
              <td className="px-3 py-2 text-right font-mono">
                {formatCost(row.estimated_cost_usd)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="rounded border border-slate-700 bg-slate-900 p-6 text-sm text-slate-400">
      No requests in this window.
    </div>
  );
}
