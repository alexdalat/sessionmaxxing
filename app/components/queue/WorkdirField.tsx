"use client";
import { useEffect, useRef, useState } from "react";
import {
  Command,
  CommandGroup,
  CommandItem,
  CommandList,
} from "@/app/components/ui/command";
import { Input } from "@/app/components/ui/input";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@/app/components/ui/popover";
import { api } from "@/app/lib/api";
import type { WorkdirSuggestions } from "@/shared/types";

const DEBOUNCE_MS = 150;
const LIST_KEYS = ["ArrowDown", "ArrowUp", "Enter"];
export const DEFAULT_WORKDIR = "/home/user/workspace";

export function WorkdirField({
  value,
  onChange,
  id,
  defaultToRecent = false,
}: {
  value: string;
  onChange: (workdir: string) => void;
  id: string;
  defaultToRecent?: boolean;
}) {
  const [query, setQuery] = useState(value);
  const [suggestions, setSuggestions] = useState<WorkdirSuggestions>();
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const prefilled = useRef(false);

  useEffect(() => {
    const timer = setTimeout(() => setQuery(value), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [value]);

  useEffect(() => {
    let live = true;
    api<WorkdirSuggestions>(`/api/workdirs?q=${encodeURIComponent(query)}`)
      .then((next) => {
        if (!live) return;
        setSuggestions(next);
        setError("");
      })
      .catch((failure: unknown) => {
        if (!live) return;
        setSuggestions(undefined);
        setError(
          failure instanceof Error
            ? failure.message
            : "Could not load directories.",
        );
      });
    return () => {
      live = false;
    };
  }, [query]);

  useEffect(() => {
    if (prefilled.current || !defaultToRecent || value || !suggestions) return;
    prefilled.current = true;
    onChange(suggestions.recent[0] ?? DEFAULT_WORKDIR);
  }, [defaultToRecent, value, suggestions, onChange]);

  const recent =
    suggestions && (!value || suggestions.recent.includes(value))
      ? suggestions.recent
      : [];
  const matches = (suggestions?.matches ?? []).filter(
    (match) => !recent.includes(match),
  );
  const hasItems = recent.length > 0 || matches.length > 0;

  function pick(workdir: string) {
    onChange(workdir);
    setOpen(false);
  }

  return (
    <Command
      className="contents bg-transparent p-0"
      shouldFilter={false}
      vimBindings={false}
    >
      <Popover open={open && hasItems} onOpenChange={setOpen}>
        <PopoverAnchor asChild>
          <Input
            ref={inputRef}
            id={id}
            name="workdir"
            required
            autoComplete="off"
            value={value}
            placeholder="/home/user/workspace/project"
            onChange={(event) => {
              onChange(event.target.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={(event) => {
              if (event.key === "Home" || event.key === "End") {
                event.stopPropagation();
                return;
              }
              if (event.key === "Escape") {
                if (!open) return;
                event.stopPropagation();
                setOpen(false);
                return;
              }
              if (event.key === "Tab") {
                setOpen(false);
                return;
              }
              if (open || !LIST_KEYS.includes(event.key)) return;
              if (event.key === "ArrowDown") setOpen(true);
              event.stopPropagation();
            }}
          />
        </PopoverAnchor>
        <PopoverContent
          align="start"
          className="w-(--radix-popover-trigger-width) p-1"
          onOpenAutoFocus={(event) => event.preventDefault()}
          onMouseDown={(event) => event.preventDefault()}
          onInteractOutside={(event) => {
            if (inputRef.current?.contains(event.target as Node))
              event.preventDefault();
          }}
        >
          <CommandList>
            {recent.length > 0 && (
              <CommandGroup heading="Recent">
                {recent.map((path) => (
                  <CommandItem key={path} value={path} onSelect={pick}>
                    {path}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {matches.length > 0 && (
              <CommandGroup heading="Folders">
                {matches.map((path) => (
                  <CommandItem key={path} value={path} onSelect={pick}>
                    {path}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </PopoverContent>
      </Popover>
      {error && (
        <p className="error mb-0" role="alert">
          {error}
        </p>
      )}
    </Command>
  );
}
