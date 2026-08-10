import { useState } from "react";
import { setToken } from "../api/client";

/**
 * Credential entry.
 *
 * The dashboard holds `DASHBOARD_API_KEY`, which the gateway accepts **only for
 * read-only stats routes**. It cannot create or revoke API keys. That separation
 * is the point: a browser app's credential is one XSS away from being someone
 * else's, and the blast radius of this one is "can read request metadata".
 *
 * It is kept in `sessionStorage`, so closing the tab clears it.
 */
export function TokenGate({ onAuthenticated }: { onAuthenticated: () => void }) {
  const [value, setValue] = useState("");

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-950 p-6">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setToken(value.trim());
          onAuthenticated();
        }}
        className="w-full max-w-md rounded border border-slate-700 bg-slate-900 p-6"
      >
        <h1 className="text-lg font-semibold text-slate-100">OpenLLM Gateway</h1>
        <p className="mt-2 text-sm text-slate-400">
          Enter the dashboard key to view request statistics.
        </p>

        <input
          type="password"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="DASHBOARD_API_KEY"
          autoComplete="off"
          className="mt-4 w-full rounded border border-slate-600 bg-slate-950 px-3 py-2 font-mono text-sm text-slate-100 outline-none focus:border-slate-400"
        />

        <button
          type="submit"
          disabled={value.trim() === ""}
          className="mt-3 w-full rounded bg-slate-100 px-3 py-2 text-sm font-medium text-slate-900 disabled:opacity-40"
        >
          Continue
        </button>

        <p className="mt-4 text-xs text-slate-500">
          This key is read-only — it cannot create or revoke API keys. It is stored for this
          browser tab only. The dashboard is an operator tool; do not expose it publicly.
        </p>
      </form>
    </div>
  );
}
