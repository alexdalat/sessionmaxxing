"use client";
import { useEffect, useState } from "react";
import type { Analytics, RangeDays } from "../shared/types";
import { readCachedAnalytics, writeCachedAnalytics } from "./analyticsCache";
import { api } from "./api";

export function useAnalytics(initialDays: RangeDays = 30) {
  const [request, setRequest] = useState<{ days: RangeDays }>({
    days: initialDays,
  });
  const [analytics, setAnalytics] = useState<Analytics>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    const cached = readCachedAnalytics(localStorage, request.days);
    if (cached) {
      setAnalytics(cached);
      setLoading(false);
    }
    api<Analytics>(`/api/analytics?days=${request.days}`, {
      signal: controller.signal,
    })
      .then((value) => {
        if (controller.signal.aborted) return;
        setAnalytics(value);
        writeCachedAnalytics(localStorage, request.days, value);
        setLoading(false);
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setError(error.message);
        setLoading(false);
      });
    return () => controller.abort();
  }, [request]);
  return {
    days: request.days,
    setDays: (days: RangeDays) => setRequest({ days }),
    analytics,
    error,
    loading,
    refresh: () => setRequest((previous) => ({ ...previous })),
  };
}
