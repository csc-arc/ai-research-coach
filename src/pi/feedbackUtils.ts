/**
 * Soft-supersede helpers for PI feedback.
 *
 * Feedback entries are append-only with UUID `id`s. A revision is a new
 * entry whose `supersedes` references the prior entry's `id`. A retraction
 * is a new entry with `retracted: true`. The "head" of a chain is the
 * entry that nothing else supersedes.
 *
 * `chainsForEntries` collapses a flat list into one chain per top-level
 * entry. A chain is `[oldest, ..., head]`, ordered by ts.
 */

import type { FeedbackEntryBase } from "./piApi";

export interface FeedbackChain<T extends FeedbackEntryBase> {
  head: T;
  history: T[];
}

export function chainsForEntries<T extends FeedbackEntryBase>(
  entries: T[] | undefined | null,
): FeedbackChain<T>[] {
  if (!entries || entries.length === 0) return [];
  const byId = new Map<string, T>();
  for (const e of entries) byId.set(e.id, e);
  const supersededIds = new Set<string>();
  for (const e of entries) {
    if (e.supersedes) supersededIds.add(e.supersedes);
  }
  const heads = entries.filter((e) => !supersededIds.has(e.id));
  // Reconstruct each chain by walking `supersedes` pointers backward.
  return heads.map((head) => {
    const history: T[] = [head];
    let cursor: T | undefined = head;
    while (cursor && cursor.supersedes) {
      const parent = byId.get(cursor.supersedes);
      if (!parent) break;
      history.unshift(parent);
      cursor = parent;
    }
    return { head, history };
  });
}
