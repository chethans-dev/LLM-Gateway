import { useEffect, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import {
  api,
  clearToken,
  getToken,
  WINDOWS,
  type RequestFilters,
  type RequestItem,
  type StatsWindow,
} from "./api/client";
import { ProviderTable } from "./components/ProviderTable";
import { RecentRequests } from "./components/RecentRequests";
import { RequestDetail } from "./components/RequestDetail";
import { RequestFilterBar } from "./components/RequestFilterBar";
import { SummaryTiles } from "./components/SummaryTiles";
import { TokenGate } from "./components/TokenGate";
import { TrafficChart } from "./components/TrafficChart";

/**
 * Spec §18: "Do not prioritize visual polish. Prioritize useful infrastructure
 * information."
 *
 * So: dense tables, monospaced numbers, and exactly one chart. The chart earns
 * its place by answering the one question no single number can — *is this
 * getting worse?* A 96% success rate reads identically whether the failures are
 * spread evenly across the window or arrived in the last four minutes, and those
 * are opposite situations.
 */
const REFRESH_MS = 10_000;

export function App() {
  const [authenticated, setAuthenticated] = useState(() => getToken() !== null);
  const [window, setWindow] = useState<StatsWindow>("24h");
  const [selected, setSelected] = useState<RequestItem | null>(null);

  if (!authenticated) {
    return <TokenGate onAuthenticated={() => setAuthenticated(true)} />;
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <Header
        window={window}
        onWindowChange={(next) => {
          setWindow(next);
          // The selected request may not exist in the new window, and a detail
          // panel showing something the table no longer lists is confusing.
          setSelected(null);
        }}
        onSignOut={() => {
          clearToken();
          setAuthenticated(false);
        }}
      />

      <main className="mx-auto max-w-7xl space-y-6 p-6">
        <Dashboard window={window} selected={selected} onSelect={setSelected} />
      </main>
    </div>
  );
}

function Dashboard({
  window,
  selected,
  onSelect,
}: {
  window: StatsWindow;
  selected: RequestItem | null;
  onSelect: (request: RequestItem | null) => void;
}) {
  const [filters, setFilters] = useState<RequestFilters>({});
  const [paused, setPaused] = useState(false);
  const [pageIndex, setPageIndex] = useState(0);

  // Polling rather than websockets: this is an operator tool watched in bursts,
  // and a 10s refresh is plenty. A live connection would be more moving parts
  // for a page nobody stares at continuously.
  const interval = paused ? (false as const) : REFRESH_MS;
  const options = { refetchInterval: interval };

  const summary = useQuery({
    queryKey: ["summary", window],
    queryFn: () => api.summary(window),
    ...options,
  });
  const providers = useQuery({
    queryKey: ["providers", window],
    queryFn: () => api.providers(window),
    ...options,
  });
  const timeseries = useQuery({
    queryKey: ["timeseries", window],
    queryFn: () => api.timeseries(window),
    ...options,
  });
  const facets = useQuery({
    queryKey: ["facets", window],
    queryFn: () => api.facets(window),
    ...options,
  });

  const recent = useInfiniteQuery({
    queryKey: ["recent", window, filters],
    queryFn: ({ pageParam }) => api.recent({ window, filters, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.next_cursor,
    ...options,
  });

  /**
   * Cursor paging, rendered one page at a time.
   *
   * The infinite query holds the chain of pages already fetched — which is what
   * makes going back instant and free — but only the active page is rendered, so
   * the table stays exactly PAGE_SIZE rows tall instead of growing.
   */
  const pages = recent.data?.pages ?? [];
  // Clamped: a refetch can return fewer pages than were open, and rendering
  // page 4 of a 2-page result is a blank table with no way back.
  const page = Math.min(pageIndex, Math.max(0, pages.length - 1));
  const rows = recent.data === undefined ? undefined : (pages[page]?.data ?? []);
  const hasNext = page < pages.length - 1 || recent.hasNextPage;

  // Reset to the newest page whenever the query itself changes, since page 3 of
  // the old filter has nothing to do with page 3 of the new one.
  useEffect(() => {
    setPageIndex(0);
  }, [window, filters]);

  // Leaving the newest page stops the auto-refresh: new traffic arrives at the
  // top and shifts every later page down, so rows would move under the cursor
  // while somebody reads. Resuming is one click.
  useEffect(() => {
    if (page > 0) setPaused(true);
  }, [page]);

  async function goNext(): Promise<void> {
    if (page < pages.length - 1) {
      setPageIndex(page + 1);
      return;
    }
    // Not fetched yet — get it, then move, so the table never blanks out.
    if (!recent.hasNextPage) return;
    const result = await recent.fetchNextPage();
    if ((result.data?.pages.length ?? 0) > page + 1) setPageIndex(page + 1);
  }

  if (summary.isError) {
    return <ErrorPanel error={summary.error as Error} />;
  }

  const isFiltered = Object.values(filters).some((value) => value !== undefined);

  return (
    <>
      <div className="flex items-center justify-between gap-4">
        <RefreshIndicator
          updatedAt={summary.dataUpdatedAt}
          fetching={summary.isFetching || recent.isFetching}
          paused={paused}
          pausedByPaging={paused && page > 0}
          onTogglePause={() => setPaused((value) => !value)}
        />
      </div>

      {summary.data !== undefined ? (
        <SummaryTiles summary={summary.data} />
      ) : (
        <Skeleton label="Loading summary…" />
      )}

      <Section title={`Requests over time — ${describeWindow(window)}`}>
        {timeseries.data !== undefined ? (
          <TrafficChart series={timeseries.data} />
        ) : (
          <Skeleton label="Loading traffic…" />
        )}
      </Section>

      <Section title="Providers">
        {providers.data !== undefined ? (
          <ProviderTable providers={providers.data} />
        ) : (
          <Skeleton label="Loading providers…" />
        )}
      </Section>

      <div className="grid gap-6 xl:grid-cols-[1fr_24rem]">
        <Section
          title="Recent requests"
          // Filters live in one row directly above the thing they filter.
          actions={
            <RequestFilterBar
              facets={facets.data}
              filters={filters}
              onChange={(next) => {
                setFilters(next);
                onSelect(null);
              }}
            />
          }
        >
          {rows !== undefined ? (
            <RecentRequests
              requests={rows}
              selectedId={selected?.id ?? null}
              onSelect={onSelect}
              page={page}
              hasPrevious={page > 0}
              hasNext={hasNext}
              onPrevious={() => setPageIndex(page - 1)}
              onNext={() => void goNext()}
              loading={recent.isFetchingNextPage}
              filtered={isFiltered}
            />
          ) : (
            <Skeleton label="Loading requests…" />
          )}
        </Section>

        {selected !== null && (
          <div className="xl:pt-9">
            <RequestDetail request={selected} onClose={() => onSelect(null)} />
          </div>
        )}
      </div>
    </>
  );
}

function describeWindow(window: StatsWindow): string {
  return WINDOWS.find((option) => option.value === window)?.label ?? window;
}

/**
 * Whether the page is live, and how stale it is.
 *
 * Without this, a dashboard that has silently stopped polling — a dropped
 * connection, a backgrounded tab, an expired credential — looks exactly like a
 * dashboard reporting that nothing is happening.
 */
function RefreshIndicator({
  updatedAt,
  fetching,
  paused,
  pausedByPaging,
  onTogglePause,
}: {
  updatedAt: number;
  fetching: boolean;
  paused: boolean;
  pausedByPaging: boolean;
  onTogglePause: () => void;
}) {
  // Local ticker so the age stays honest between refetches, scoped to this
  // component so a 1s interval does not re-render the tables.
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((value) => value + 1), 1_000);
    return () => clearInterval(timer);
  }, []);

  const seconds = updatedAt === 0 ? null : Math.floor((Date.now() - updatedAt) / 1_000);

  return (
    <div className="flex items-center gap-2 text-xs text-slate-500">
      <span
        aria-hidden="true"
        className={`inline-block h-1.5 w-1.5 rounded-full ${
          fetching ? "animate-pulse bg-sky-400" : paused ? "bg-slate-600" : "bg-emerald-500"
        }`}
      />
      <span>
        {/* The dot is a convenience, never the message — it is 6px of color with
            no label, which is not something to make anyone rely on. */}
        {paused ? "Paused" : fetching ? "Refreshing…" : "Live"}
        {seconds !== null && <> · updated {seconds}s ago</>}
        {pausedByPaging && <> · auto-refresh off while paging</>}
      </span>
      <button
        onClick={onTogglePause}
        className="rounded border border-slate-700 px-1.5 py-0.5 text-slate-400 hover:bg-slate-800"
      >
        {paused ? "Resume" : "Pause"}
      </button>
    </div>
  );
}

function Header({
  window,
  onWindowChange,
  onSignOut,
}: {
  window: StatsWindow;
  onWindowChange: (window: StatsWindow) => void;
  onSignOut: () => void;
}) {
  return (
    <header className="border-b border-slate-800 bg-slate-900">
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 p-4">
        <div>
          <h1 className="text-sm font-semibold uppercase tracking-wide text-slate-200">
            OpenLLM Gateway
          </h1>
          <p className="text-xs text-slate-500">Request metadata only — no prompts are stored.</p>
        </div>

        <div className="flex items-center gap-2">
          <label className="sr-only" htmlFor="stats-window">
            Time window
          </label>
          <select
            id="stats-window"
            value={window}
            onChange={(event) => onWindowChange(event.target.value as StatsWindow)}
            className="rounded border border-slate-600 bg-slate-950 px-2 py-1 text-sm text-slate-200"
          >
            {WINDOWS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <button
            onClick={onSignOut}
            className="rounded border border-slate-600 px-2 py-1 text-sm text-slate-400 hover:bg-slate-800"
          >
            Sign out
          </button>
        </div>
      </div>
    </header>
  );
}

function Section({
  title,
  actions,
  children,
}: {
  title: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-400">{title}</h2>
        {actions}
      </div>
      {children}
    </section>
  );
}

function Skeleton({ label }: { label: string }) {
  return (
    <div className="rounded border border-slate-800 bg-slate-900 p-6 text-sm text-slate-500">
      {label}
    </div>
  );
}

function ErrorPanel({ error }: { error: Error }) {
  return (
    <div className="rounded border border-rose-800 bg-rose-950/40 p-4">
      <div className="text-sm font-medium text-rose-300">Could not load statistics</div>
      <div className="mt-1 font-mono text-xs text-rose-400">{error.message}</div>
      <div className="mt-3 text-xs text-slate-400">
        Check that the gateway is reachable and that DASHBOARD_API_KEY is set on it.
      </div>
    </div>
  );
}
