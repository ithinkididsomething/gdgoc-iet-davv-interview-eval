export const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined;
export const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
export const API_URL = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') ?? '';
export const OFFLINE_SESSION_HOURS = Number(import.meta.env.VITE_OFFLINE_SESSION_HOURS ?? 12);

function isUsableSupabaseConfig(url?: string, key?: string): boolean {
  if (!url || !key) return false;
  if (url.includes('YOUR_PROJECT_REF') || key === 'YOUR_ANON_KEY') return false;
  return /^https?:\/\//i.test(url);
}

export const SUPABASE_CONFIGURED = isUsableSupabaseConfig(SUPABASE_URL, SUPABASE_ANON_KEY);

/** Explicit demo flag, or automatic fallback when no real Supabase project is configured. */
export const DEMO_MODE =
  import.meta.env.VITE_DEMO_MODE === 'true' ||
  import.meta.env.VITE_DEMO_MODE === '1' ||
  !SUPABASE_CONFIGURED;
