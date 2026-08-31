"use client";

import { useEffect, useState } from "react";

export function StrategySettings() {
  const [value, setValue] = useState("1.5");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    fetch("/api/agent/status", { cache: "no-store" }).then((response) => response.json()).then((body) => {
      if (body.minHealthFactor) setValue(String(body.minHealthFactor));
    }).catch(() => undefined);
  }, []);

  async function save() {
    const response = await fetch("/api/agent/settings", { method: "POST", headers: { "content-type": "application/json", "x-wallet-token": window.localStorage.getItem("cadence_wallet_token") ?? "" }, body: JSON.stringify({ minHealthFactor: Number(value) }) });
    setSaved(response.ok);
    window.setTimeout(() => setSaved(false), 2500);
  }

  return (
    <section className="rounded-xl border border-ink-650 bg-ink-850 p-5 sm:p-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div><h2 className="text-xs uppercase tracking-widest text-muted">Safety strategy</h2><h3 className="text-lg text-paper mt-2">Your minimum health factor</h3><p className="text-sm text-muted mt-1">Cadence will prioritize keeping the position above this level.</p></div>
        <div className="flex items-center gap-2"><input value={value} onChange={(event) => setValue(event.target.value)} type="number" min="1" max="10" step="0.1" className="w-24 rounded-md border border-ink-650 bg-ink-950/60 px-3 py-2 text-sm text-paper font-mono focus:border-jade/60 focus:outline-none" /><button onClick={save} className="rounded-md bg-ink-750 border border-ink-650 px-3 py-2 text-sm text-jade hover:border-jade/50">{saved ? "Saved" : "Save"}</button></div>
      </div>
      <p className="text-xs text-muted mt-4 border-t border-ink-650 pt-3">This is a strategy preference. PolicyModule remains the final authority and can block any action.</p>
    </section>
  );
}
