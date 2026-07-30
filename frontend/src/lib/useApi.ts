import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '../api/client';

interface ApiState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

/**
 * Minimal fetch-on-mount hook. Deliberately not react-query — three read-only screens
 * don't need a cache layer, and keeping the dependency list short matters more here.
 * `reload` lets a screen refresh after a mutation.
 */
export function useApi<T>(fetcher: () => Promise<T>, deps: unknown[] = []): ApiState<T> & {
  reload: () => void;
  setData: (data: T) => void;
} {
  const [state, setState] = useState<ApiState<T>>({ data: null, loading: true, error: null });
  const [reloadToken, setReloadToken] = useState(0);

  const reload = useCallback(() => setReloadToken((n) => n + 1), []);
  const setData = useCallback((data: T) => setState({ data, loading: false, error: null }), []);

  useEffect(() => {
    let cancelled = false;
    setState((prev) => ({ ...prev, loading: true, error: null }));

    fetcher()
      .then((data) => {
        if (!cancelled) setState({ data, loading: false, error: null });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof ApiError || err instanceof Error ? err.message : String(err);
        setState({ data: null, loading: false, error: message });
      });

    return () => {
      // Prevents a late response from a previous render overwriting fresher state.
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, reloadToken]);

  return { ...state, reload, setData };
}
