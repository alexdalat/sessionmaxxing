import { Button } from "@/app/components/ui/button";
import { Label } from "@/app/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/app/components/ui/select";
import type { RangeDays } from "@/shared/types";
import { RANGE_DAYS } from "@/shared/types";

export function RangeControls({
  days,
  onChange,
  onRefresh,
}: {
  days: RangeDays;
  onChange: (days: RangeDays) => void;
  onRefresh: () => void;
}) {
  return (
    <div className="header-controls">
      <div className="grid gap-1.5">
        <Label htmlFor="range-days" className="sr-only">
          Range
        </Label>
        <Select
          value={String(days)}
          onValueChange={(value) => onChange(Number(value) as RangeDays)}
        >
          <SelectTrigger id="range-days">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {RANGE_DAYS.map((n) => (
              <SelectItem key={n} value={String(n)}>
                {n} days
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <Button type="button" variant="outline" onClick={onRefresh}>
        Refresh
      </Button>
    </div>
  );
}
