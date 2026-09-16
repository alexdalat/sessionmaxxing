"use client";
import { Badge } from "@/app/components/ui/badge";
import type { PlanningSnapshot } from "@/shared/types";

export function QueueBadges({ planning }: { planning?: PlanningSnapshot }) {
  if (!planning) return null;
  const ready = planning.providers.claude.status === "ready";
  return (
    <>
      <Badge variant={ready ? "success" : "warning"}>
        {ready ? "Claude ready" : "Claude waiting"}
      </Badge>
      {planning.settings.autoApply && (
        <Badge variant="outline" className="text-muted-foreground">
          Auto-apply
        </Badge>
      )}
      {planning.settings.keepSessionActive && (
        <Badge variant="outline" className="text-muted-foreground">
          Session keeper
        </Badge>
      )}
    </>
  );
}
