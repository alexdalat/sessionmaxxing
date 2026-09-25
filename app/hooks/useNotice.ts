"use client";
import { useEffect, useState } from "react";

const NOTICE_MS = 4000;
export function useNotice() {
  const [notice, setNotice] = useState("");
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);
  return [notice, setNotice] as const;
}
