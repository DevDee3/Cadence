"use client";

import { useEffect, useState } from "react";
import { useAccount, useChainId, useSwitchChain, useWaitForTransactionReceipt, useWriteContract } from "wagmi";
import { parseUnits, type Address } from "viem";
import { CONTRACTS } from "@/lib/contracts";
import { arcTestnet } from "@/lib/chain";

const erc20 = [{
  type: "function" as const,
  name: "transfer" as const,
  stateMutability: "nonpayable" as const,
  inputs: [
    { name: "to", type: "address" as const },
    { name: "amount", type: "uint256" as const },
  ],
  outputs: [{ name: "", type: "bool" as const }],
}] as const;

export function PositionSetup() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { switchChain, switchChainAsync, isPending: switching } = useSwitchChain();
  const { writeContract, data: hash, isPending, error } = useWriteContract();
  const { isLoading: depositConfirming, isSuccess: depositConfirmed, isError: depositFailed } = useWaitForTransactionReceipt({ hash });
  const [gasHash, setGasHash] = useState<string>();
  const [gasError, setGasError] = useState<string>();
  const [gasPending, setGasPending] = useState(false);
  const { isLoading: gasConfirming, isSuccess: gasConfirmed, isError: gasFailed } = useWaitForTransactionReceipt({ hash: gasHash as `0x${string}` | undefined });
  const [amount, setAmount] = useState("");
  const [gasAmount, setGasAmount] = useState("1");
  const [assignedAgentAccount, setAssignedAgentAccount] = useState<string>();
  const [accountLookupFailed, setAccountLookupFailed] = useState(false);

  async function refreshAssignedAccount() {
    try {
      const response = await fetch("/api/agent/account", { cache: "no-store" });
      if (response.ok) {
        setAccountLookupFailed(false);
        setAssignedAgentAccount((await response.json()).agentAccount ?? undefined);
      } else {
        setAccountLookupFailed(true);
      }
    } catch {
      // The configured account remains available for the existing local setup.
      setAccountLookupFailed(true);
    }
  }

  useEffect(() => {
    void refreshAssignedAccount();
    const onAccountReady = () => void refreshAssignedAccount();
    window.addEventListener("cadence:account-ready", onAccountReady);
    return () => window.removeEventListener("cadence:account-ready", onAccountReady);
  }, []);

  const targetAgentAccount = (assignedAgentAccount ?? (accountLookupFailed ? CONTRACTS.agentAccount : undefined)) as Address | undefined;

  async function ensureArcNetwork() {
    if (chainId === arcTestnet.id) return true;
    try {
      await switchChainAsync({ chainId: arcTestnet.id });
      return true;
    } catch {
      return false;
    }
  }

  async function deposit() {
    if (!CONTRACTS.collateralToken || !targetAgentAccount || !amount) return;
    if (!(await ensureArcNetwork())) return;
    writeContract({
      address: CONTRACTS.collateralToken,
      abi: erc20,
      functionName: "transfer",
      args: [targetAgentAccount, parseUnits(amount, 18)],
      chain: arcTestnet,
    });
  }

  async function fundGas() {
    if (!targetAgentAccount) return;
    const provider = (window as Window & { ethereum?: { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> } }).ethereum;
    if (!provider || !address) {
      setGasError("MetaMask was not detected.");
      return;
    }
    setGasPending(true);
    setGasError(undefined);
    try {
      const chainHex = `0x${arcTestnet.id.toString(16)}`;
      try {
        await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: chainHex }] });
      } catch (switchError) {
        if ((switchError as { code?: number }).code !== 4902) throw switchError;
        await provider.request({ method: "wallet_addEthereumChain", params: [{
          chainId: chainHex,
          chainName: "Arc Testnet",
          nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
          rpcUrls: ["https://rpc.testnet.arc.network"],
          blockExplorerUrls: ["https://testnet.arcscan.app"],
        }] });
        await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: chainHex }] });
      }
      const activeChain = await provider.request({ method: "eth_chainId" });
      if (String(activeChain).toLowerCase() !== chainHex) throw new Error("MetaMask did not switch to Arc Testnet; transaction cancelled.");
      const gasValue = parseUnits(gasAmount, 18);
      if (gasValue <= 0n) throw new Error("Enter a positive gas amount.");
      const hash = await provider.request({ method: "eth_sendTransaction", params: [{
        from: address,
        to: targetAgentAccount,
        value: `0x${gasValue.toString(16)}`,
      }] });
      setGasHash(String(hash));
    } catch (cause) {
      setGasError(cause instanceof Error ? cause.message : "Network switch or transaction was rejected.");
    } finally {
      setGasPending(false);
    }
  }

  return (
    <section className="rounded-xl border border-ink-650 bg-ink-850 p-5 sm:p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-xs uppercase tracking-widest text-muted">Start a protected position</h2>
          <h3 className="text-lg text-paper mt-2">Fund Cadence with collateral</h3>
          <p className="text-sm text-muted mt-1 max-w-2xl">Send mCOL to your AgentAccount. Cadence can then supply it into the lending pool when your policy allows.</p>
        </div>
        <span className="hidden sm:block text-xs text-brass border border-brass/30 bg-brass-dim rounded-full px-2.5 py-1">18 decimals</span>
      </div>

      {!isConnected ? (
        <p className="text-sm text-brass mt-5">Connect your wallet above to fund your AgentAccount.</p>
      ) : !address ? null : chainId !== arcTestnet.id ? (
        <div className="mt-5 rounded-md border border-brass/30 bg-brass-dim p-3"><p className="text-sm text-brass">Switch MetaMask to Arc Testnet before funding Cadence.</p><button onClick={() => switchChain({ chainId: arcTestnet.id })} disabled={switching} className="mt-2 rounded-md border border-brass/50 px-3 py-1.5 text-xs text-brass hover:bg-brass/20">{switching ? "Switching…" : "Switch network"}</button></div>
      ) : !CONTRACTS.collateralToken || !targetAgentAccount ? (
        <p className="text-sm text-brass mt-5">Verify your wallet and create an AgentAccount before funding a position.</p>
      ) : (
        <div className="mt-5 flex flex-col sm:flex-row gap-2">
          <input value={amount} onChange={(event) => setAmount(event.target.value)} type="number" min="0" step="any" placeholder="Amount of mCOL" className="min-w-0 flex-1 rounded-md border border-ink-650 bg-ink-950/60 px-3 py-2.5 text-sm text-paper placeholder:text-muted focus:border-jade/60 focus:outline-none" />
          <button onClick={deposit} disabled={isPending || !amount} className="rounded-md border border-brass/50 bg-brass-dim px-4 py-2.5 text-sm text-brass hover:bg-brass/20 disabled:opacity-40">
            {isPending ? "Confirming…" : "Deposit collateral"}
          </button>
        </div>
      )}
      {isConnected && targetAgentAccount && chainId === arcTestnet.id && (
        <div className="mt-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-t border-ink-650 pt-4">
          <div><p className="text-sm text-paper-dim">Execution gas</p><p className="text-xs text-muted mt-1">Choose how much native Arc USDC Cadence can use for UserOperations.</p></div>
          <div className="flex gap-2"><input value={gasAmount} onChange={(event) => setGasAmount(event.target.value)} type="number" min="0" step="any" className="w-28 rounded-md border border-ink-650 bg-ink-950/60 px-3 py-2 text-sm text-paper font-mono focus:border-jade/60 focus:outline-none" aria-label="Native USDC gas amount" /><button onClick={fundGas} disabled={gasPending || !gasAmount} className="rounded-md border border-jade/40 bg-jade-dim px-4 py-2 text-sm text-jade hover:bg-jade/20 disabled:opacity-40">{gasPending ? "Confirming…" : "Fund gas"}</button></div>
        </div>
      )}
      {isConnected && targetAgentAccount && chainId !== arcTestnet.id && (
        <div className="mt-4 border-t border-ink-650 pt-4 text-xs text-brass">
          Switch to Arc Testnet above before funding execution gas. No transaction can be submitted from the wrong network.
        </div>
      )}
      {hash && <p className={`font-mono text-xs mt-3 break-all ${depositConfirmed ? "text-jade" : depositFailed ? "text-clay" : "text-muted"}`}>Collateral {depositConfirmed ? "confirmed" : depositFailed ? "failed" : depositConfirming ? "confirming" : "submitted"}: {hash}</p>}
      {error && <p className="text-xs text-clay mt-3">{error.message.slice(0, 180)}</p>}
      {gasHash && <p className={`font-mono text-xs mt-3 break-all ${gasConfirmed ? "text-jade" : gasFailed ? "text-clay" : "text-muted"}`}>Gas funding {gasConfirmed ? "confirmed" : gasFailed ? "failed" : gasConfirming ? "confirming" : "submitted"}: {gasHash}</p>}
      {gasError && <p className="text-xs text-clay mt-3">{gasError.slice(0, 180)}</p>}
    </section>
  );
}
