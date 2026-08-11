/**
 * Typed client for the gateway's read-only stats API.
 *
 * All network access lives here. Components receive data and render it — spec
 * §22: no business logic in components, which in practice means no fetch calls,
 * no URL building and no response shaping inside a `.tsx` file.
 *
 * Requests are same-origin: nginx (production) and the Vite dev proxy both
 * forward `/v1` to the gateway. Nothing here knows the gateway's address, and
 * there is no CORS configuration anywhere as a result.
 */

export type StatsWindow = "1h" | "24h" | "7d" | "30d";

export const WINDOWS: readonly { value: StatsWindow; label: string }[] = [
  { value: "1h", label: "Last hour" },
  { value: "24h", label: "Last 24 hours" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
];

export interface Summary {
  readonly total_requests: number;
  readonly successful_requests: number;
  readonly failed_requests: number;
  /** Null when there is no traffic — 100% of nothing is not 100%. */
  readonly success_rate: number | null;
  readonly average_latency_ms: number | null;
  readonly p95_latency_ms: number | null;
  readonly total_tokens: number;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly estimated_cost_usd: number;
  /** Requests whose model had no pricing, so the total above excludes them. */
  readonly requests_without_cost: number;
  readonly cached_requests: number;
}

export interface ProviderStats {
  readonly provider: string;
  readonly requests: number;
  readonly successful_requests: number;
  readonly average_latency_ms: number | null;
  readonly total_tokens: number;
  readonly estimated_cost_usd: number;
}

export interface RequestItem {
  readonly id: string;
  readonly request_id: string;
  readonly trace_id: string;
  readonly created_at: string;
  readonly provider: string | null;
  readonly model: string | null;
  readonly requested_model: string;
  readonly status: "success" | "error";
  readonly error_code: string | null;
  readonly http_status: number;
  readonly latency_ms: number;
  readonly total_tokens: number | null;
  /** Null when pricing is unknown. Rendered as "—", never as $0.00. */
  readonly estimated_cost_usd: number | null;
  readonly cached: boolean;
  readonly streamed: boolean;
}

export interface RequestDetail extends RequestItem {
  readonly route: string | null;
  readonly api_key_id: string | null;
  readonly provider_calls: number;
  readonly input_tokens: number | null;
  readonly output_tokens: number | null;
}

export interface TimeBucket {
  readonly bucket_start: string;
  readonly total: number;
  readonly errors: number;
}

export interface TimeSeries {
  readonly bucket_seconds: number;
  readonly data: readonly TimeBucket[];
}

export interface Facets {
  readonly providers: readonly string[];
  readonly models: readonly string[];
}

/** Absent keys mean "no filter"; the query string omits them entirely. */
export interface RequestFilters {
  readonly status?: "success" | "error";
  readonly provider?: string;
  readonly model?: string;
}

export interface RequestPage {
  readonly data: readonly RequestItem[];
  readonly next_cursor: string | null;
}

/**
 * Rows per page.
 *
 * Small enough that a page fits on screen without scrolling the table out from
 * under the filter controls, which is the point of paging rather than appending.
 */
export const PAGE_SIZE = 15;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Where the credential lives.
 *
 * `sessionStorage`, not `localStorage`: it is cleared when the tab closes, so a
 * shared or forgotten machine does not keep an operator credential indefinitely.
 *
 * The key held here is `DASHBOARD_API_KEY`, which is read-only by design — the
 * gateway will not accept it for key management. That separation exists because
 * whatever a browser app holds is one XSS away from being someone else's, and it
 * must not be a credential that can mint API keys.
 */
const TOKEN_STORAGE_KEY = "openllm.dashboard.token";

export function getToken(): string | null {
  return sessionStorage.getItem(TOKEN_STORAGE_KEY);
}

export function setToken(token: string): void {
  sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
}

export function clearToken(): void {
  sessionStorage.removeItem(TOKEN_STORAGE_KEY);
}

async function request<T>(path: string): Promise<T> {
  const token = getToken();

  const response = await fetch(path, {
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    let message = `Request failed with status ${response.status}`;
    try {
      const body = (await response.json()) as { error?: { message?: string } };
      if (body.error?.message !== undefined) message = body.error.message;
    } catch {
      // Non-JSON error body; the status alone is what we have.
    }
    throw new ApiError(response.status, message);
  }

  return (await response.json()) as T;
}

export const api = {
  summary: (window: StatsWindow) =>
    request<Summary>(`/v1/admin/stats/summary?window=${window}`),

  providers: (window: StatsWindow) =>
    request<{ data: ProviderStats[] }>(`/v1/admin/stats/providers?window=${window}`).then(
      (body) => body.data,
    ),

  timeseries: (window: StatsWindow) =>
    request<TimeSeries>(`/v1/admin/stats/timeseries?window=${window}`),

  facets: (window: StatsWindow) => request<Facets>(`/v1/admin/stats/facets?window=${window}`),

  recent: (options: {
    window: StatsWindow;
    filters?: RequestFilters;
    cursor?: string | null;
    limit?: number;
  }) => {
    // URLSearchParams rather than string concatenation: model names contain
    // slashes and colons (`mock/echo`, `anthropic:claude-…`) and a hand-built
    // query string quietly mangles them into a filter that matches nothing.
    const params = new URLSearchParams({
      window: options.window,
      limit: String(options.limit ?? PAGE_SIZE),
    });
    for (const [key, value] of Object.entries(options.filters ?? {})) {
      if (value !== undefined) params.set(key, value);
    }
    if (options.cursor != null) params.set("cursor", options.cursor);

    return request<RequestPage>(`/v1/admin/requests?${params.toString()}`);
  },

  detail: (id: string) => request<RequestDetail>(`/v1/admin/requests/${encodeURIComponent(id)}`),

  trace: (traceId: string) =>
    request<{ data: RequestItem[] }>(`/v1/admin/traces/${encodeURIComponent(traceId)}`).then(
      (body) => body.data,
    ),
};
