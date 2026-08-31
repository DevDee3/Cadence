import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CadenceConfig } from "../config.js";
import { supabaseEnabled, supabaseRequest } from "../supabase.js";

type SavedSettings = { enabled: boolean; minHealthFactor: number };
type SupabaseSettings = { enabled: boolean; min_health_factor: number };
type SettingsStore = Record<string, SavedSettings>;
const file = join(process.cwd(), "data", "agent-settings.json");

export async function loadSettings(cfg: CadenceConfig, account: string, defaults: SavedSettings): Promise<SavedSettings> {
  if (supabaseEnabled(cfg)) {
    try {
      const rows = await supabaseRequest<SupabaseSettings[]>(cfg, `agent_settings?agent_account=eq.${account}&select=enabled,min_health_factor`);
      if (rows[0]) return { enabled: rows[0].enabled, minHealthFactor: Number(rows[0].min_health_factor) };
    } catch { /* retain local fallback during first-time setup */ }
  }
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as SettingsStore;
    const saved = parsed[account.toLowerCase()];
    return saved ? { ...defaults, ...saved } : defaults;
  } catch {
    return defaults;
  }
}

export async function saveSettings(cfg: CadenceConfig, account: string, settings: SavedSettings) {
  if (supabaseEnabled(cfg)) {
    await supabaseRequest(cfg, "agent_settings?on_conflict=agent_account", { method: "POST", headers: { Prefer: "resolution=merge-duplicates" }, body: JSON.stringify({ agent_account: account.toLowerCase(), enabled: settings.enabled, min_health_factor: settings.minHealthFactor, updated_at: new Date().toISOString() }) });
    return;
  }
  mkdirSync(dirname(file), { recursive: true });
  let store: SettingsStore = {};
  try { store = JSON.parse(readFileSync(file, "utf8")) as SettingsStore; } catch { /* first write */ }
  store[account.toLowerCase()] = settings;
  writeFileSync(file, JSON.stringify(store, null, 2), "utf8");
}
