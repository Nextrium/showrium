import { createAuthClient } from "better-auth/react";
import { useCallback, useEffect, useRef, useState } from "react";

// showrium.com is the public website; the product runs on app.showrium.com.
// Locally (and on preview URLs) everything runs on one origin.
const WEBSITE_HOST = "showrium.com";
export const isWebsite = window.location.hostname === WEBSITE_HOST;
export const APP_ORIGIN = isWebsite ? "https://app.showrium.com" : "";

export const authClient = createAuthClient();

// --- Unsaved changes: forms register while they have edits; leaving asks first. ---

const unsaved = new Set<string>();
export function setUnsaved(key: string, dirty: boolean) {
  if (dirty) unsaved.add(key);
  else unsaved.delete(key);
}
window.addEventListener("beforeunload", (e) => {
  if (unsaved.size) e.preventDefault();
});
function confirmLeave() {
  if (!unsaved.size) return true;
  if (!window.confirm("You have unsaved changes. Leave without saving?")) return false;
  unsaved.clear();
  return true;
}

// --- Minimal router (a handful of pages doesn't need a routing library) ---

export function navigate(to: string) {
  if (!confirmLeave()) return;
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

// --- Theme: light, dark or follow the system. Stored per browser. ---

export type ThemeChoice = "system" | "light" | "dark";
const THEME_KEY = "showrium_theme";
const media = window.matchMedia("(prefers-color-scheme: dark)");
export function getTheme(): ThemeChoice {
  try {
    const t = localStorage.getItem(THEME_KEY);
    return t === "light" || t === "dark" ? t : "system";
  } catch {
    return "system";
  }
}
export function applyTheme(choice: ThemeChoice = getTheme()) {
  const dark = choice === "dark" || (choice === "system" && media.matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
}
export function setTheme(choice: ThemeChoice) {
  try {
    if (choice === "system") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, choice);
  } catch {
    // Storage unavailable: the choice lasts for this page only.
  }
  applyTheme(choice);
  window.dispatchEvent(new Event("showrium:theme"));
}
media.addEventListener("change", () => applyTheme());

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

// --- Workspace selection: people in several workspaces pick one; the API gets it as X-Org-Id. ---

const ORG_KEY = "showrium_org";
export function currentOrgId(): string | null {
  try {
    return localStorage.getItem(ORG_KEY);
  } catch {
    return null;
  }
}
export function switchWorkspace(id: string | null) {
  try {
    if (id) localStorage.setItem(ORG_KEY, id);
    else localStorage.removeItem(ORG_KEY);
  } catch {
    // Storage unavailable: stay in the default workspace.
  }
  window.location.assign("/app");
}
export function orgHeaders(): Record<string, string> {
  const id = currentOrgId();
  return id ? { "X-Org-Id": id } : {};
}

/** Tells every mounted `useApi` that data changed, so all screens show the same truth. */
export function dataChanged() {
  window.dispatchEvent(new Event("showrium:changed"));
}

// Identical reads in flight share one request (many cards on a page ask for the same list).
const inflight = new Map<string, Promise<unknown>>();

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const read = !init.method || init.method === "GET";
  if (read && !init.body) {
    const key = `${currentOrgId() ?? ""}|${path}`;
    const pending = inflight.get(key);
    if (pending) return pending as Promise<T>;
    const p = request<T>(path, init).finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }
  return request<T>(path, init);
}

async function request<T>(path: string, init: RequestInit): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    ...init,
    headers: { ...(init.body ? { "Content-Type": "application/json" } : {}), ...orgHeaders(), ...init.headers },
  });
  const mutating = Boolean(init.method && init.method !== "GET");
  if (res.status === 204) {
    if (mutating) dataChanged();
    return undefined as T;
  }
  const body = (await res.json().catch(() => null)) as { error?: { code: string; message: string } } | null;
  // The chosen workspace is gone (removed from the team): fall back to the default one.
  if (res.status === 403 && body?.error?.code === "no_workspace" && currentOrgId()) switchWorkspace(null);
  if (!res.ok) throw new ApiError(res.status, body?.error?.code ?? "error", body?.error?.message ?? `Request failed (${res.status}).`);
  if (mutating) dataChanged();
  return body as T;
}

/**
 * Loads `path` and keeps it fresh: it reloads after any change made in the app, and when the
 * tab becomes visible again. Old data stays on screen while reloading (no flicker), and a slow
 * earlier response can never overwrite a newer one. `null` skips loading.
 */
export function useApi<T>(path: string | null, opts: { live?: boolean } = {}) {
  const live = opts.live ?? true;
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(path));
  const latest = useRef(0);
  const reload = useCallback(() => {
    if (!path) return;
    const id = ++latest.current;
    setLoading(true);
    api<T>(path)
      .then((d) => {
        if (id !== latest.current) return;
        setData(d);
        setError(null);
      })
      .catch((e: unknown) => {
        if (id === latest.current) setError(e instanceof Error ? e.message : "Something went wrong.");
      })
      .finally(() => {
        if (id === latest.current) setLoading(false);
      });
  }, [path]);
  useEffect(() => {
    setData(null);
    reload();
  }, [reload]);
  useEffect(() => {
    if (!live) return;
    // Several changes in a row (bulk approve, quick edits) cause one refresh, not one each:
    // it keeps the page responsive and well inside the API's rate limit.
    let timer: number | undefined;
    const soon = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(reload, 250);
    };
    const onVisible = () => document.visibilityState === "visible" && soon();
    window.addEventListener("showrium:changed", soon);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("showrium:changed", soon);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [reload, live]);
  return { data, error, loading, reload };
}

/**
 * Editing saved data: `draft` starts as the saved value, `dirty` says whether anything changed,
 * and leaving the page with changes asks first. After saving, pass the new saved value in and
 * the form is clean again.
 */
export function useEditable<T>(key: string, saved: T | null | undefined) {
  const [draft, setDraft] = useState<T | null>(null);
  const savedJson = saved === undefined || saved === null ? null : JSON.stringify(saved);
  useEffect(() => {
    if (savedJson !== null) setDraft(JSON.parse(savedJson) as T);
  }, [savedJson]);
  const dirty = draft !== null && savedJson !== null && JSON.stringify(draft) !== savedJson;
  useEffect(() => {
    setUnsaved(key, dirty);
    return () => setUnsaved(key, false);
  }, [key, dirty]);
  const reset = useCallback(() => setDraft(savedJson === null ? null : (JSON.parse(savedJson) as T)), [savedJson]);
  return { draft, setDraft, dirty, reset };
}

export const formatDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "never";
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  if (s < 7 * 86_400) return `${Math.round(s / 86_400)} d ago`;
  return formatDate(iso);
}
