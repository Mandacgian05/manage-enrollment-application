// The content workspace runs in the browser only (never in the prerendered pages).
export const cmsPreviewEnabled = !import.meta.env.SSR;

// With the site connected to Supabase, the workspace saves to the school database and the
// public pages show what is published there. Without keys (local development) it falls back
// to a preview that keeps changes in this browser.
export const cmsDatabaseEnabled = !import.meta.env.SSR
  && /^https:\/\/[a-z0-9]+\.supabase\.co\/?$/.test(String(import.meta.env.VITE_SUPABASE_URL ?? ""))
  && String(import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? "").startsWith("sb_publishable_");
