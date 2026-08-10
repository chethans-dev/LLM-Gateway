import type { RequestItem } from "../api/client";
import { formatAge, formatCost, formatCount, formatLatency, formatTime } from "../api/format";

/**
 * Recent requests (spec §18).
 *
 * Every column here is metadata. There is no prompt or completion to show,
 * because none is stored — spec §18's "do not show prompts/completions" is
 * satisfied by there being nothing to omit.
 */
export function RecentRequests({
  requests,
  selectedId,
  onSelect,
}: {
  requests: readonly RequestItem[];
  selectedId: string | null;
  onSelect: (request: RequestItem) => void;
}) {
  if (requests.length === 0) {
    return (
      <div className="rounded border border-slate-700 bg-slate-900 p-6 text-sm text-slate-400">
        No requests in this window.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded border border-slate-700">
      <table className="w-full text-left text-sm">
        <thead className="bg-slate-800 text-xs uppercase tracking-wide text-slate-400">
          <tr>
            <th className="px-3 py-2">Time</th>
            <th className="px-3 py-2">Provider</th>
            <th className="px-3 py-2">Model</th>
            <th className="px-3 py-2 text-right">Latency</th>
            <th className="px-3 py-2 text-right">Tokens</th>
            <th className="px-3 py-2">Status</th>
            <th className="px-3 py-2 text-right">Est. cost</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-800">
          {requests.map((request) => (
            <tr
              key={request.id}
              onClick={() => onSelect(request)}
              className={`cursor-pointer ${
                selectedId === request.id ? "bg-slate-800" : "bg-slate-900 hover:bg-slate-800/60"
              }`}
            >
              <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-slate-400">
                <span title={formatTime(request.created_at)}>{formatAge(request.created_at)}</span>
              </td>
              <td className="px-3 py-2 font-mono text-slate-300">
                {request.provider ?? <span className="text-slate-600">—</span>}
              </td>
              <td className="px-3 py-2 font-mono text-slate-300">
                {request.model ?? request.requested_model}
                {request.streamed && <Tag>stream</Tag>}
                {request.cached && <Tag>cached</Tag>}
              </td>
              <td className="px-3 py-2 text-right font-mono">
                {formatLatency(request.latency_ms)}
              </td>
              <td className="px-3 py-2 text-right font-mono">
                {formatCount(request.total_tokens)}
              </td>
              <td className="px-3 py-2">
                <StatusBadge request={request} />
              </td>
              <td className="px-3 py-2 text-right font-mono">
                {formatCost(request.estimated_cost_usd)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Tag({ children }: { children: React.ReactNode }) {
  return (
    <span className="ml-2 rounded bg-slate-700 px-1.5 py-0.5 text-[10px] uppercase text-slate-300">
      {children}
    </span>
  );
}

function StatusBadge({ request }: { request: RequestItem }) {
  if (request.status === "success") {
    return <span className="font-mono text-xs text-emerald-400">{request.http_status}</span>;
  }

  return (
    <span className="font-mono text-xs text-rose-400">
      {request.http_status}
      {/* The normalized code, not a provider's raw message — that is what the
          router made its decision from, so it is what an operator should see. */}
      {request.error_code !== null && (
        <span className="ml-1 text-slate-500">{request.error_code}</span>
      )}
    </span>
  );
}
