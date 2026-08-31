import type { CadenceConfig } from "./config.js";

export function supabaseEnabled(cfg: CadenceConfig) {
  return Boolean(cfg.SUPABASE_URL && cfg.SUPABASE_SERVICE_ROLE_KEY);
}

export async function supabaseRequest<T>(cfg: CadenceConfig, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${cfg.SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: cfg.SUPABASE_SERVICE_ROLE_KEY!,
      ...(cfg.SUPABASE_SERVICE_ROLE_KEY!.startsWith("eyJ") ? { Authorization: `Bearer ${cfg.SUPABASE_SERVICE_ROLE_KEY!}` } : {}),
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) throw new Error(`Supabase request failed (${response.status}): ${await response.text()}`);
  const text = await response.text();
  return (text ? JSON.parse(text) : undefined) as T;
}
