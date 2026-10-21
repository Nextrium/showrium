/**
 * A path under /api/v1, or an error. Values from the page address (?id=, ?status=) reach paths, so
 * nothing may climb out of /api/v1 or point at another host: no "..", "//", backslashes, control
 * characters or schemes. Kept free of browser globals so the tests can import it.
 */
export function apiPath(path: string): string {
  if (!path.startsWith("/") || path.startsWith("//") || /\.\.|\\|[\u0000-\u001f]/.test(path) || /^\/[a-z][a-z0-9+.-]*:/i.test(path)) {
    throw new Error("That link isn't valid.");
  }
  return `/api/v1${path}`;
}
