import { Badge } from "@/app/components/ui/badge";
import type { PlanningSnapshot } from "@/shared/types";

export function QueueStatus({
  planning,
  queueOn,
}: {
  planning: PlanningSnapshot | undefined;
  queueOn: boolean | undefined;
}) {
  if (!planning || queueOn === undefined) return null;
  if (!queueOn) return <Badge>Paused</Badge>;
  return planning.gate.status === "ready" ? (
    <Badge variant="success">Ready</Badge>
  ) : (
    <Badge variant="warning">Waiting</Badge>
  );
}
