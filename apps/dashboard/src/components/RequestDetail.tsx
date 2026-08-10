import { useQuery } from "@tanstack/react-query";
import { api, type RequestItem } from "../api/client";
import { formatCost, formatCount, formatDateTime, formatLatency } from "../api/format";

/**
 * Request detail (spec §18).
 *
 * Trace ID is first and copyable: it is the field that turns "a user reported a
 * problem" into "here is exactly what happened", and it is the one an operator
 * pastes from a client's error report.
 */
export function RequestDetail({ request, onClose }: { request: RequestItem; onClose: () => void }) {
  const detail = useQuery({
    queryKey: ["request", request.id],
    queryFn: () => api.detail(request.id),
  });

  // Everything sharing this trace — the reason trace IDs are adopted from
  // callers rather than always minted here (spec §15).
  const trace = useQuery({
    queryKey: ["trace", request.trace_id],
    queryFn: () => api.trace(request.trace_id),
  });

  const data = detail.data;

  return (
    <aside className="rounded border border-slate-700 bg-slate-900">
      <header className="flex items-center justify-between border-b border-slate-700 px-4 py-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-300">
          Request detail
        </h2>
        <button
          onClick={onClose}
          className="rounded px-2 py-1 text-xs text-slate-400 hover:bg-slate-800"
        >
          Close
        </button>
      </header>

      {detail.isPending && <div className="p-4 text-sm text-slate-400">Loading…</div>}
      {detail.isError && (
        <div className="p-4 text-sm text-rose-400">{(detail.error as Error).message}</div>
      )}

      {data !== undefined && (
        <dl className="divide-y divide-slate-800">
          <Row label="Trace ID" value={data.trace_id} mono copyable />
          <Row label="Request ID" value={data.request_id} mono copyable />
          <Row label="Time" value={formatDateTime(data.created_at)} />
          <Row label="Status" value={`${data.http_status} ${data.status}`} />
          {data.error_code !== null && <Row label="Error" value={data.error_code} mono />}
          <Row label="Requested model" value={data.requested_model} mono />
          <Row label="Route" value={data.route ?? "—"} mono />
          <Row label="Provider" value={data.provider ?? "—"} mono />
          <Row label="Served model" value={data.model ?? "—"} mono />
          <Row label="Latency" value={formatLatency(data.latency_ms)} />
          <Row
            label="Provider calls"
            value={String(data.provider_calls)}
            // Anything above 1 means a retry or a failover happened, which is
            // usually the answer to "why was this request slow".
            hint={data.provider_calls > 1 ? "retried or failed over" : undefined}
          />
          <Row
            label="Tokens"
            value={`${formatCount(data.input_tokens)} in / ${formatCount(data.output_tokens)} out`}
            hint={`${formatCount(data.total_tokens)} total`}
          />
          <Row
            label="Estimated cost"
            value={formatCost(data.estimated_cost_usd)}
            hint={data.estimated_cost_usd === null ? "no pricing configured for this model" : "estimate"}
          />
          <Row label="Cached" value={data.cached ? "yes" : "no"} />
          <Row label="Streamed" value={data.streamed ? "yes" : "no"} />
          <Row label="API key" value={data.api_key_id ?? "unauthenticated"} mono />
        </dl>
      )}

      {trace.data !== undefined && trace.data.length > 1 && (
        <div className="border-t border-slate-700 px-4 py-3">
          <div className="text-xs uppercase tracking-wide text-slate-400">
            {trace.data.length} requests share this trace
          </div>
        </div>
      )}

      <footer className="border-t border-slate-700 px-4 py-3 text-xs text-slate-500">
        Prompts and completions are never stored, so there is nothing more to show here.
      </footer>
    </aside>
  );
}

function Row({
  label,
  value,
  mono,
  hint,
  copyable,
}: {
  label: string;
  value: string;
  mono?: boolean;
  hint?: string | undefined;
  copyable?: boolean;
}) {
  return (
    <div className="grid grid-cols-3 gap-2 px-4 py-2 text-sm">
      <dt className="text-slate-400">{label}</dt>
      <dd className="col-span-2 break-all text-slate-200">
        <span className={mono === true ? "font-mono text-xs" : undefined}>{value}</span>
        {copyable === true && (
          <button
            onClick={() => void navigator.clipboard.writeText(value)}
            className="ml-2 rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-400 hover:bg-slate-700"
          >
            copy
          </button>
        )}
        {hint !== undefined && <div className="mt-0.5 text-xs text-slate-500">{hint}</div>}
      </dd>
    </div>
  );
}
