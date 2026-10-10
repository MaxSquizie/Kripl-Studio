import { useCallback, useLayoutEffect, useRef } from "react";

/** Stable UI/subscription callback that always reads the latest committed state. */
export function useLatestCallback<Args extends unknown[], Result>(
  callback: (...args: Args) => Result
): (...args: Args) => Result {
  const latest = useRef(callback);
  useLayoutEffect(() => {
    latest.current = callback;
  });
  return useCallback((...args: Args) => latest.current(...args), []);
}
