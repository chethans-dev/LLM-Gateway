import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, clearToken, getToken, WINDOWS, type RequestItem, type StatsWindow } from "./api/client";
import { ProviderTable } from "./components/ProviderTable";
import { RecentRequests } from "./components/RecentRequests";
import { RequestDetail } from "./components/RequestDetail";
import { SummaryTiles } from "./components/SummaryTiles";
import { TokenGate } from "./components/TokenGate";

/**
 * Spec §18: "Do not prioritize visual polish. Prioritize useful infrastructure
 * information."
 *
 * So: dense tables, monospaced numbers, no charts. The questions this answers
 * are "is it working", "what is it costing", and "what happened to that one
 * request" — none of which is better served by a graph than by a number.
 */
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
        onWindowChange={setWindow}
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
  // Polling rather than websockets: this is an operator tool watched in bursts,
  // and a 10s refresh is plenty. A live connection would be more moving parts
  // for a page nobody stares at continuously.
  const options = { refetchInterval: 10_000 };

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
  const recent = useQuery({
    queryKey: ["recent", window],
    queryFn: () => api.recent(window),
    ...options,
  });

  if (summary.isError) {
    return <ErrorPanel error={summary.error as Error} />;
  }

  return (
    <>
      {summary.data !== undefined ? (
        <SummaryTiles summary={summary.data} />
      ) : (
        <Skeleton label="Loading summary…" />
      )}

      <Section title="Providers">
        {providers.data !== undefined ? (
          <ProviderTable providers={providers.data} />
        ) : (
          <Skeleton label="Loading providers…" />
        )}
      </Section>

      <div className="grid gap-6 xl:grid-cols-[1fr_24rem]">
        <Section title="Recent requests">
          {recent.data !== undefined ? (
            <RecentRequests
              requests={recent.data}
              selectedId={selected?.id ?? null}
              onSelect={onSelect}
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
          <select
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

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-400">{title}</h2>
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
