import { api } from "./api";

export interface Brand {
  orgName: string;
  brandPrimary: string;
  brandAccent: string;
  logoUrl: string | null;
}

export const DEFAULT_BRAND: Brand = { orgName: "openv360", brandPrimary: "#0d6b63", brandAccent: "#f2b544", logoUrl: null };

let current: Brand = DEFAULT_BRAND;
const listeners = new Set<(b: Brand) => void>();

/** Apply brand colors to the document root; a cache-buster keeps the logo fresh. */
export function applyBrand(b: Brand) {
  current = b;
  const root = document.documentElement;
  root.style.setProperty("--primary", b.brandPrimary);
  root.style.setProperty("--accent", b.brandAccent);
  document.title = b.orgName === "openv360" ? "openv360" : `${b.orgName} · openv360`;
  listeners.forEach((fn) => fn(b));
}

export function getBrand(): Brand {
  return current;
}

/** Subscribe to brand changes (returns an unsubscribe fn). */
export function onBrand(fn: (b: Brand) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Fetch the public branding (works before login) and apply it. */
export async function loadBrand(): Promise<Brand> {
  try {
    const b = await api<Brand>("/api/branding");
    applyBrand(b);
    return b;
  } catch {
    applyBrand(DEFAULT_BRAND);
    return DEFAULT_BRAND;
  }
}

/** Logo URL with a cache-buster so a freshly uploaded logo shows immediately. */
export function logoSrc(url: string | null, v = 0): string | null {
  return url ? `${url}${url.includes("?") ? "&" : "?"}v=${v}` : null;
}
