"use client";

import { useAccount, useDisconnect, useSignMessage } from "wagmi";
import { useAppKit } from "@reown/appkit/react";
import { useEffect, useState } from "react";
import { isConfigured } from "@/lib/contracts";
import { shortAddress } from "@/lib/format";

export function StatusHeader() {
  const { address, isConnected, isReconnecting } = useAccount();
  const { open } = useAppKit();
  const { disconnect } = useDisconnect();
  const { signMessageAsync, isPending: isSigning } = useSignMessage();
  const [verified, setVerified] = useState(false);
  const [agentAccount, setAgentAccount] = useState<string>();
  const [provisioningAvailable, setProvisioningAvailable] = useState(false);
  const [provisioning, setProvisioning] = useState(false);
  const [authError, setAuthError] = useState("");

  useEffect(() => {
    // During a reload Wagmi briefly has no address while it restores the
    // previous connector. Do not erase the session during that window.
    if (!isConnected && isReconnecting) return;
    if (!address) {
      setVerified(false);
      setAgentAccount(undefined);
      setProvisioningAvailable(false);
      return;
    }
    fetch("/api/auth/session", { cache: "no-store" })
      .then((response) => response.ok ? response.json() : Promise.reject(new Error("Session expired.")))
      .then(async (session) => {
        const matches = session.address?.toLowerCase() === address.toLowerCase();
        setVerified(matches);
        if (matches) {
          const accountResponse = await fetch("/api/agent/account", { cache: "no-store" });
          if (accountResponse.ok) {
            const account = await accountResponse.json();
            setAgentAccount(account.agentAccount ?? undefined);
            setProvisioningAvailable(Boolean(account.provisioningAvailable));
          }
        }
      })
      .catch(() => { setVerified(false); setAgentAccount(undefined); });
  }, [address, isConnected, isReconnecting]);

  async function verifyWallet() {
    if (!address) return;
    setAuthError("");
    try {
      const challengeResponse = await fetch("/api/auth/challenge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address }),
      });
      const challenge = await challengeResponse.json();
      if (!challengeResponse.ok) throw new Error(challenge.error ?? "Could not create verification message.");

      const signature = await signMessageAsync({ message: challenge.message });
      const verifyResponse = await fetch("/api/auth/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address, signature }),
      });
      const result = await verifyResponse.json();
      if (!verifyResponse.ok) throw new Error(result.error ?? "Wallet verification failed.");
      setVerified(true);
    } catch (error) {
      if (error instanceof Error && !error.message.toLowerCase().includes("user rejected")) {
        setAuthError(error.message);
      }
    }
  }

  async function provisionAccount() {
    setProvisioning(true);
    setAuthError("");
    try {
      const response = await fetch("/api/agent/provision", { method: "POST" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "AgentAccount provisioning failed.");
      setAgentAccount(result.agentAccount);
      window.dispatchEvent(new CustomEvent("cadence:account-ready"));
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "AgentAccount provisioning failed.");
    } finally {
      setProvisioning(false);
    }
  }

  async function connectWallet() {
    setAuthError("");
    try {
      await open({ view: "Connect" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Wallet connection failed.";
      if (!/user rejected|connection request reset/i.test(message)) setAuthError(message);
    }
  }

  return (
    <header className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-6 border-b border-ink-650">
      <div>
        <h1 className="font-display italic text-2xl sm:text-3xl text-paper tracking-tight">
          Cadence
        </h1>
        <p className="text-sm text-muted mt-1">
          Autonomous position management on{" "}
          <span className="text-paper-dim">Arc Testnet</span>
        </p>
      </div>

      <div className="relative flex items-center gap-3">
        <span
          className={`inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full border ${
            isConfigured
              ? "border-jade/40 text-jade bg-jade-dim"
              : "border-clay/40 text-clay bg-clay-dim"
          }`}
        >
          <span
            className={`w-1.5 h-1.5 rounded-full ${isConfigured ? "bg-jade" : "bg-clay"}`}
            aria-hidden
          />
          {isConfigured ? "Contracts configured" : "Not configured"}
        </span>

        {isConnected && address ? (
          <div className="flex items-center gap-2">
            {verified && agentAccount && <span className="hidden lg:inline text-[11px] text-muted" title={agentAccount}>Agent linked · {shortAddress(agentAccount as `0x${string}`)}</span>}
            {verified && !agentAccount && provisioningAvailable && <button onClick={provisionAccount} disabled={provisioning} className="text-xs rounded-md border border-brass/40 px-2.5 py-1.5 text-brass hover:bg-brass-dim disabled:opacity-60">{provisioning ? "Creating agent…" : "Create AgentAccount"}</button>}
            <button
              onClick={verifyWallet}
              disabled={verified || isSigning}
              className="text-xs rounded-md border border-jade/40 px-2.5 py-1.5 text-jade hover:bg-jade-dim disabled:cursor-default disabled:opacity-80"
            >
              {isSigning ? "Sign in wallet…" : verified ? "Wallet verified" : "Verify wallet"}
            </button>
            <button
              onClick={() => { void fetch("/api/auth/logout", { method: "POST" }); setVerified(false); disconnect(); }}
              className="text-sm font-mono tabular px-3 py-1.5 rounded-md border border-ink-650 text-paper-dim hover:border-jade/50 hover:text-jade transition-colors"
            >
              {shortAddress(address)}
            </button>
          </div>
        ) : (
          <button
            onClick={() => void connectWallet()}
            className="text-sm px-3 py-1.5 rounded-md bg-ink-750 border border-ink-650 text-paper hover:border-jade/50 hover:text-jade transition-colors"
          >
            Connect wallet
          </button>
        )}
        {authError && <p className="absolute right-0 top-12 z-10 mt-10 max-w-64 text-right text-xs text-clay">{authError}</p>}
      </div>
    </header>
  );
}
