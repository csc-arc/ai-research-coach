/**
 * Global server configuration state for the script execution backend.
 * The selected URL can be changed at runtime; subscribers are notified.
 *
 * For AI Research Coach, the remote droplet is the default. Local mode is
 * available for development against a locally-running ai-research-coach server.
 *
 * Targeting precedence on load (see `resolveInitialServerUrl`):
 *   1. A `?server=` query param (`staging` | `prod`/`remote` | `local` | an
 *      explicit https URL) — wins and is persisted in sessionStorage.
 *   2. A choice persisted earlier in this browser session.
 *   3. The hostname default: `staging.airesearchcoach.org` → staging backend,
 *      `localhost` → local dev backend, everything else → prod backend.
 *
 * This lets a tester open
 *   https://airesearchcoach.org/?server=staging&student_id=...&project_id=...
 * and exercise the staging backend with the prod frontend build.
 */

const REMOTE_SERVER_URL = "https://airesearchcoach-server.airesearchcoach.org";
const STAGING_SERVER_URL = "https://staging-server.airesearchcoach.org";
const LOCAL_SERVER_URL = "http://localhost:3339";

const SERVER_STORAGE_KEY = "arc.serverUrl";

/** Hostname-based default, used when no query param or stored choice exists. */
function hostnameDefaultServerUrl(): string {
  const host = window.location.hostname;
  if (host === "localhost") return LOCAL_SERVER_URL;
  if (host === "staging.airesearchcoach.org") return STAGING_SERVER_URL;
  return REMOTE_SERVER_URL;
}

const DEFAULT_SERVER_URL = hostnameDefaultServerUrl();

/**
 * Resolve a `?server=` param value to a concrete URL, or null if it isn't a
 * value we accept. Named targets cover the common cases; an explicit URL is
 * accepted only over https (or http://localhost) so the param can't point the
 * app at an arbitrary host.
 */
function resolveServerParam(value: string): string | null {
  switch (value) {
    case "staging":
      return STAGING_SERVER_URL;
    case "remote":
    case "prod":
      return REMOTE_SERVER_URL;
    case "local":
      return LOCAL_SERVER_URL;
    default:
      if (/^https:\/\/[^\s]+$/.test(value)) return value;
      if (/^http:\/\/localhost(:\d+)?$/.test(value)) return value;
      return null;
  }
}

function readStoredServerUrl(): string | null {
  try {
    return sessionStorage.getItem(SERVER_STORAGE_KEY);
  } catch {
    return null;
  }
}

function persistServerUrl(url: string): void {
  try {
    sessionStorage.setItem(SERVER_STORAGE_KEY, url);
  } catch {
    // sessionStorage may be unavailable (private mode, etc.); ignore.
  }
}

function resolveInitialServerUrl(): string {
  // 1. Explicit query param wins and is persisted for the session so it
  //    survives reloads (e.g. the SPA navigating within the chat session).
  try {
    const serverParam = new URLSearchParams(window.location.search).get(
      "server",
    );
    if (serverParam) {
      const resolved = resolveServerParam(serverParam);
      if (resolved) {
        persistServerUrl(resolved);
        return resolved;
      }
    }
  } catch {
    // Malformed URL/search; fall through to stored/default.
  }

  // 2. Choice persisted earlier in this session (query param or selector).
  const stored = readStoredServerUrl();
  if (stored) return stored;

  // 3. Hostname-based default.
  return DEFAULT_SERVER_URL;
}

let currentServerUrl = resolveInitialServerUrl();

type ServerUrlListener = (url: string) => void;
const listeners: Set<ServerUrlListener> = new Set();

/** Get the current server URL */
export function getServerUrl(): string {
  return currentServerUrl;
}

/** Set the server URL, persist it for the session, and notify listeners */
export function setServerUrl(url: string): void {
  currentServerUrl = url;
  persistServerUrl(url);
  listeners.forEach((listener) => listener(url));
}

/** Switch to the remote (droplet) server */
export function useRemoteServer(): void {
  setServerUrl(REMOTE_SERVER_URL);
}

/** Switch to the staging (droplet) server */
export function useStagingServer(): void {
  setServerUrl(STAGING_SERVER_URL);
}

/** Switch to the local development server (http://localhost:3339) */
export function useLocalServer(): void {
  setServerUrl(LOCAL_SERVER_URL);
}

/**
 * Backwards-compatible alias for code paths that previously called
 * `usePublicServer()`. Now equivalent to switching to the remote server.
 */
export function usePublicServer(): void {
  useRemoteServer();
}

/** Subscribe to server URL changes; returns an unsubscribe function */
export function subscribeToServerUrl(listener: ServerUrlListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getRemoteServerUrl(): string {
  return REMOTE_SERVER_URL;
}

export function getStagingServerUrl(): string {
  return STAGING_SERVER_URL;
}

export function getLocalServerUrl(): string {
  return LOCAL_SERVER_URL;
}

export function getDefaultServerUrl(): string {
  return DEFAULT_SERVER_URL;
}
