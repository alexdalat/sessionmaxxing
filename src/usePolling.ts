import { useCallback, useEffect, useState } from "react";
import { api } from "./api";

const DEFAULT_INTERVAL_MS = 2000;
export function usePolling<T>(path: string, intervalMs = DEFAULT_INTERVAL_MS) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState("");
  const [request, setRequest] = useState({ path });
  const reload = useCallback(() => setRequest({ path }), [path]);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const value = await api<T>(request.path, { signal: controller.signal });
        if (!controller.signal.aborted) {
          setData(value);
          setError("");
        }
      } catch (error) {
        if (!controller.signal.aborted)
          setError(
            error instanceof Error
              ? error.message
              : "Could not load local data.",
          );
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(poll, intervalMs);
      }
    };
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [request, intervalMs]);
  return { data, error, reload };
}
