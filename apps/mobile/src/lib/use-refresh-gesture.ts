/**
 * Pull-to-refresh that runs its work at most once per gesture (increment 10, ruling T3): a pull
 * that arrives while the previous one is still running is ignored, not queued, so an impatient
 * second pull never becomes a second request. The guard is a ref, not state, because two pulls
 * can land before React re-renders with `refreshing` true.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export interface RefreshGesture {
  readonly refreshing: boolean;
  /** Starts the work unless a run is in flight; returns whether it started. */
  readonly onRefresh: () => boolean;
}

export function useRefreshGesture(work: () => Promise<void>): RefreshGesture {
  const [refreshing, setRefreshing] = useState(false);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const workRef = useRef(work);
  workRef.current = work;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const onRefresh = useCallback((): boolean => {
    if (inFlight.current) {
      return false;
    }
    inFlight.current = true;
    setRefreshing(true);
    void workRef
      .current()
      .catch(() => undefined)
      .finally(() => {
        inFlight.current = false;
        if (mounted.current) {
          setRefreshing(false);
        }
      });
    return true;
  }, []);

  return { refreshing, onRefresh };
}
