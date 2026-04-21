/**
 * Global server configuration state for the script execution backend.
 * The selected URL can be changed at runtime; subscribers are notified.
 *
 * For AI Research Coach, the remote droplet is the default. Local mode is
 * available for development against a locally-running ai-research-coach server.
 */

const REMOTE_SERVER_URL = "https://airesearchcoach-server.airesearchcoach.org";
const LOCAL_SERVER_URL = "http://localhost:3339";

// Dev override: default to the local server so `npm run dev` talks to
// http://localhost:3339 out of the box. Flip back to REMOTE_SERVER_URL before
// shipping a production build.
const DEFAULT_SERVER_URL = LOCAL_SERVER_URL;

let currentServerUrl = DEFAULT_SERVER_URL;

type ServerUrlListener = (url: string) => void;
const listeners: Set<ServerUrlListener> = new Set();

/** Get the current server URL */
export function getServerUrl(): string {
  return currentServerUrl;
}

/** Set the server URL and notify listeners */
export function setServerUrl(url: string): void {
  currentServerUrl = url;
  listeners.forEach((listener) => listener(url));
}

/** Switch to the remote (droplet) server */
export function useRemoteServer(): void {
  setServerUrl(REMOTE_SERVER_URL);
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

export function getLocalServerUrl(): string {
  return LOCAL_SERVER_URL;
}

export function getDefaultServerUrl(): string {
  return DEFAULT_SERVER_URL;
}
