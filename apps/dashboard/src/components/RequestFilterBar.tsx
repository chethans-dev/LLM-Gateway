import type { Facets, RequestFilters } from "../api/client";

/**
 * Filters, in one row above the table.
 *
 * Every option comes from `facets` — the providers and models that actually
 * served traffic in the selected window — rather than from configuration. A
 * dropdown offering a configured-but-idle provider only ever produces an empty
 * table, and an operator cannot tell that apart from a broken filter.
 */
export function RequestFilterBar({
  facets,
  filters,
  onChange,
}: {
  facets: Facets | undefined;
  filters: RequestFilters;
  onChange: (filters: RequestFilters) => void;
}) {
  const active = Object.values(filters).filter((value) => value !== undefined).length;

  // `exactOptionalPropertyTypes` is on and the API client omits absent keys from
  // the query string, so clearing a filter must delete the key rather than set
  // it to undefined.
  function set<K extends keyof RequestFilters>(key: K, value: string): void {
    const next = { ...filters };
    if (value === "") delete next[key];
    else next[key] = value as RequestFilters[K];
    onChange(next);
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select
        label="Status"
        value={filters.status ?? ""}
        onChange={(value) => set("status", value)}
        options={[
          { value: "success", label: "Successful" },
          { value: "error", label: "Errors" },
        ]}
      />
      <Select
        label="Provider"
        value={filters.provider ?? ""}
        onChange={(value) => set("provider", value)}
        options={(facets?.providers ?? []).map((provider) => ({
          value: provider,
          // `unrouted` is the gateway's own name for requests that failed before
          // a provider was chosen; spelling it out beats making people guess.
          label: provider === "unrouted" ? "unrouted (no provider reached)" : provider,
        }))}
      />
      <Select
        label="Model"
        value={filters.model ?? ""}
        onChange={(value) => set("model", value)}
        options={(facets?.models ?? []).map((model) => ({ value: model, label: model }))}
      />

      {active > 0 && (
        <button
          onClick={() => onChange({})}
          className="rounded border border-slate-600 px-2 py-1 text-xs text-slate-300 hover:bg-slate-800"
        >
          Clear {active === 1 ? "filter" : `${active} filters`}
        </button>
      )}
    </div>
  );
}

function Select({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly { value: string; label: string }[];
}) {
  return (
    <label className="flex items-center gap-1.5 text-xs text-slate-500">
      {label}
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        // Disabled rather than hidden when the window contains no traffic: a
        // control that vanishes reads as a bug, one that is greyed out reads as
        // "nothing to choose from yet".
        disabled={options.length === 0}
        className="rounded border border-slate-600 bg-slate-950 px-2 py-1 text-xs text-slate-200 disabled:opacity-50"
      >
        <option value="">All</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}
