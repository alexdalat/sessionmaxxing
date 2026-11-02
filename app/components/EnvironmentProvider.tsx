"use client";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useState,
} from "react";
import { api } from "@/app/lib/api";
import type { Environment } from "@/shared/types";

const LOAD_ERROR = "Could not load the server environment.";

const EnvironmentContext = createContext<Environment | null>(null);

export function EnvironmentProvider({ children }: { children: ReactNode }) {
  const [environment, setEnvironment] = useState<Environment>();
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    api<Environment>("/api/environment", { signal: controller.signal })
      .then((value) => {
        if (!controller.signal.aborted) setEnvironment(value);
      })
      .catch((failure) => {
        if (!controller.signal.aborted)
          setError(failure instanceof Error ? failure.message : LOAD_ERROR);
      });
    return () => controller.abort();
  }, []);
  if (error)
    return (
      <div className="error" role="alert">
        {error}
      </div>
    );
  if (!environment) return null;
  return (
    <EnvironmentContext.Provider value={environment}>
      {children}
    </EnvironmentContext.Provider>
  );
}

export function useEnvironment(): Environment {
  const environment = useContext(EnvironmentContext);
  if (!environment) {
    throw new Error("useEnvironment must be used inside EnvironmentProvider.");
  }
  return environment;
}
