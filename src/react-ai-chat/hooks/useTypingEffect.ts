import { useEffect, useRef, useState } from "react";

/**
 * Characters emitted per tick. At TICK_MS=50 this gives ~60 chars/sec,
 * a comfortable conversational reading pace.
 *
 * Tune upward if responses feel too slow for longer messages.
 */
const CHARS_PER_TICK = 3;
const TICK_MS = 50;

/**
 * Returns the previous value of a variable (one render behind).
 * Used to detect transitions in boolean flags.
 */
function usePrevious<T>(value: T): T | undefined {
  const ref = useRef<T | undefined>(undefined);
  useEffect(() => {
    ref.current = value;
  });
  return ref.current;
}

/**
 * Drip-feeds `target` to the display at a natural pace (~60 chars/sec).
 *
 * - While `active` is true: new characters are queued and emitted gradually.
 * - When `active` flips to false: remaining queue is flushed immediately so
 *   there's no awkward lag after the model finishes.
 * - When `active` flips to true: state resets for the next response.
 */
export const useTypingEffect = (target: string, active: boolean): string => {
  const [displayed, setDisplayed] = useState("");
  const pendingRef = useRef("");
  const prevTargetLenRef = useRef(0);
  const prevActive = usePrevious(active);

  // New stream starting → reset
  useEffect(() => {
    if (!prevActive && active) {
      setDisplayed("");
      pendingRef.current = "";
      prevTargetLenRef.current = 0;
    }
  }, [active, prevActive]);

  // Stream finished → reveal everything immediately
  useEffect(() => {
    if (prevActive && !active && target) {
      setDisplayed(target);
      pendingRef.current = "";
      prevTargetLenRef.current = target.length;
    }
  }, [active, prevActive, target]);

  // Enqueue newly arrived characters
  useEffect(() => {
    if (!active) return;
    if (target.length > prevTargetLenRef.current) {
      pendingRef.current += target.slice(prevTargetLenRef.current);
      prevTargetLenRef.current = target.length;
    }
  }, [target, active]);

  // Drip timer: emit CHARS_PER_TICK characters every TICK_MS ms
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      if (!pendingRef.current) return;
      const chunk = pendingRef.current.slice(0, CHARS_PER_TICK);
      pendingRef.current = pendingRef.current.slice(CHARS_PER_TICK);
      setDisplayed((d) => d + chunk);
    }, TICK_MS);
    return () => clearInterval(timer);
  }, [active]);

  return displayed;
};
