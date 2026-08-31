"use client";

import { useAccount } from "wagmi";
import { useEffect, useState } from "react";
import type { Address } from "viem";
import { CONTRACTS } from "./contracts";

/** Resolves the wallet-scoped account while retaining the configured account
 * as a compatibility fallback when the backend is unavailable. */
export function useResolvedAgentAccount() {
  const { address, isConnected } = useAccount();
  const [assigned, setAssigned] = useState<Address>();
  const [lookupFailed, setLookupFailed] = useState(false);

  useEffect(() => {
    if (!isConnected || !address) {
      setAssigned(undefined);
      setLookupFailed(false);
      return;
    }
    let cancelled = false;
    fetch("/api/agent/account", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("Account lookup failed");
        const body = await response.json() as { agentAccount?: Address };
        if (!cancelled) { setAssigned(body.agentAccount); setLookupFailed(false); }
      })
      .catch(() => { if (!cancelled) setLookupFailed(true); });
    const refresh = () => void fetch("/api/agent/account", { cache: "no-store" }).then(async (response) => {
      if (response.ok && !cancelled) setAssigned((await response.json()).agentAccount);
    });
    window.addEventListener("cadence:account-ready", refresh);
    return () => { cancelled = true; window.removeEventListener("cadence:account-ready", refresh); };
  }, [address, isConnected]);

  return { agentAccount: assigned ?? (lookupFailed ? CONTRACTS.agentAccount : undefined), address };
}
