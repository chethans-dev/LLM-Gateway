import { useState } from "react";
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
  page,
  hasPrevious,
  hasNext,
  onPrevious,
  onNext,
  loading,
  filtered,
}: {
  requests: readonly RequestItem[];
  selectedId: string | null;
  onSelect: (request: RequestItem) => void;
  /** Zero-based; displayed as page + 1. */
  page: number;
  hasPrevious: boolean;
  hasNext: boolean;
  onPrevious: () => void;
  onNext: () => void;
  loading: boolean;
  filtered: boolean;
}) {
  if (requests.length === 0) {
    return (
      <div className="rounded border border-slate-700 bg-slate-900 p-6 text-sm text-slate-400">
        {/* Distinguishing the two matters: "no traffic" is a fact about the
            gateway, "no matches" is a fact about the filters, and showing the
            first when the second is true sends people debugging the wrong thing. */}
        {filtered ? "No requests match these filters." : "No requests in this window."}
      </div>
    );
  }

  return (
    <div className="space-y-2">
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
              <th className="px-3 py-2">Trace</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {requests.map((request) => (
              <tr
                key={request.id}
                // A click handler on a bare <tr> is invisible to the keyboard —
                // there is nothing to tab to and nothing to press. The row needs
                // a role, a tab stop, and Enter/Space handling before it counts
                // as a control at all.
                role="button"
                tabIndex={0}
                aria-label={`Request ${request.request_id}, ${request.status}`}
                aria-pressed={selectedId === request.id}
                onClick={() => onSelect(request)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" && event.key !== " ") return;
                  // Space scrolls the page by default, which would yank the row
                  // out from under the person who just activated it.
                  event.preventDefault();
                  onSelect(request);
                }}
                className={`cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sky-400 ${
                  selectedId === request.id ? "bg-slate-800" : "bg-slate-900 hover:bg-slate-800/60"
                }`}
              >
                <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-slate-400">
                  <span title={formatTime(request.created_at)}>
                    {formatAge(request.created_at)}
                  </span>
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
                <td className="px-3 py-2">
                  <CopyButton value={request.trace_id} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {(hasPrevious || hasNext) && (
        <nav className="flex items-center justify-between gap-2" aria-label="Request pages">
          <PageButton onClick={onPrevious} disabled={!hasPrevious || loading}>
            ← Newer
          </PageButton>

          {/* No total: counting every matching row on each page turn is a second
              full scan of the window, and the number is not worth it. */}
          <span className="font-mono text-xs text-slate-500" aria-live="polite">
            {loading ? "Loading…" : `Page ${page + 1}`}
          </span>

          <PageButton onClick={onNext} disabled={!hasNext || loading}>
            Older →
          </PageButton>
        </nav>
      )}
    </div>
  );
}

function PageButton({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void;
  disabled: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="rounded border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
    </button>
  );
}

function Tag({ children }: { children: React.ReactNode }) {
  return (
    <span className="ml-2 rounded bg-slate-700 px-1.5 py-0.5 text-[10px] uppercase text-slate-300">
      {children}
    </span>
  );
}

/**
 * A trace ID is only useful somewhere else — in a log query, a bug report, a
 * grep. Making it selectable by hand from a dense monospace table is the kind of
 * small friction that stops people using the feature at all.
 */
function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      // The row is itself a button; without this the copy click also opens the
      // detail panel.
      onClick={(event) => {
        event.stopPropagation();
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1_200);
        });
      }}
      onKeyDown={(event) => event.stopPropagation()}
      title={value}
      aria-label={`Copy trace id ${value}`}
      className="rounded border border-slate-700 px-1.5 py-0.5 font-mono text-[10px] text-slate-400 hover:bg-slate-700 hover:text-slate-200"
    >
      {copied ? "copied" : "copy"}
    </button>
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
