/**
 * Tiny in-app pub/sub for "a feedback item was just written."
 *
 * Used by `DraftsAppBarWidget` to refresh its `new since last synth`
 * counter the moment a feedback POST returns, instead of waiting for the
 * 30s server-side cache to expire. `SessionViewer`'s feedback POST
 * handlers call `notifyFeedbackWritten()` alongside their existing
 * `onBundleRefresh()` callback.
 *
 * Module-level state by design — there's no React context wiring to do.
 */

type Listener = () => void;

let counter = 0;
const listeners = new Set<Listener>();

export function notifyFeedbackWritten(): void {
  counter += 1;
  for (const l of listeners) {
    try {
      l();
    } catch {
      // Listener errors must not break other subscribers.
    }
  }
}

export function subscribeFeedbackWrites(cb: Listener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function getFeedbackWriteCounter(): number {
  return counter;
}
