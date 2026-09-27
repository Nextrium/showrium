import { createAuthClient } from "better-auth/react";
import { useCallback, useEffect, useState } from "react";

// showrium.com is the public website; the product runs on app.showrium.com.
// Locally (and on preview URLs) everything runs on one origin.
const WEBSITE_HOST = "showrium.com";
export const isWebsite = window.location.hostname === WEBSITE_HOST;
export const APP_ORIGIN = isWebsite ? "https://app.showrium.com" : "";

export const authClient = createAuthClient();

// --- Minimal router (a handful of pages doesn't need a routing library) ---

export function navigate(to: string) {
  window.history.pushState({}, "", to);
  window.dispatchEvent(new PopStateEvent("popstate"));
  window.scrollTo(0, 0);
}

export function usePath(): string {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const onChange = () => setPath(window.location.pathname);
    onChange(); // pick up any navigation that happened before this listener was attached
    window.addEventListener("popstate", onChange);
    return () => window.removeEventListener("popstate", onChange);
  }, []);
  return path;
}

/** Navigate after render (navigating during render can be missed). */
export function useRedirect(to: string, when: boolean) {
  useEffect(() => {
    if (when) navigate(to);
  }, [to, when]);
}

// --- API client for /api/v1 (same origin, session cookie) ---

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    ...init,
    headers: { ...(init.body ? { "Content-Type": "application/json" } : {}), ...init.headers },
  });
  if (res.status === 204) return undefined as T;
  const body = (await res.json().catch(() => null)) as { error?: { code: string; message: string } } | null;
  if (!res.ok) throw new ApiError(res.status, body?.error?.code ?? "error", body?.error?.message ?? `Request failed (${res.status}).`);
  return body as T;
}

export function useApi<T>(path: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => {
    api<T>(path)
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Something went wrong."));
  }, [path]);
  useEffect(reload, [reload]);
  return { data, error, reload };
}

export const formatDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
