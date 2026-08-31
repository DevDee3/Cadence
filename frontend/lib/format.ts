import { toFunctionSelector, formatUnits } from "viem";

/** Computes the 4-byte selector for a canonical Solidity function signature,
 *  e.g. "repay(uint256)" -> "0x..." — used so the Policy Panel queries
 *  PolicyModule with the exact same selector AgentAccount's calldata
 *  decoder and ConfigureAgent.s.sol compute, rather than a hand-copied
 *  hex literal that could silently drift out of sync. */
export function selectorFor(signature: string): `0x${string}` {
  return toFunctionSelector(signature);
}

/** Formats a bigint token amount for display, trimming to a sane number
 *  of decimal places for a dashboard (not a precise accounting output). */
export function formatAmount(value: bigint, decimals: number, maxFractionDigits = 4): string {
  const formatted = formatUnits(value, decimals);
  const [whole, frac] = formatted.split(".");
  if (!frac) return whole;
  return `${whole}.${frac.slice(0, maxFractionDigits)}`;
}

/** Health factor is stored on-chain as a 1e18-precision uint256.
 *  type(uint256).max signals "no debt" (infinite health) — render that
 *  specially rather than as a giant number. */
export const UINT256_MAX = (1n << 256n) - 1n;

export function formatHealthFactor(hf: bigint): string {
  if (hf === UINT256_MAX) return "∞";
  return formatAmount(hf, 18, 2);
}

export function shortAddress(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function shortTxHash(hash: string): string {
  return `${hash.slice(0, 8)}…${hash.slice(-6)}`;
}
