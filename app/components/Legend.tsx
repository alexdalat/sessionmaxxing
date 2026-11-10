import type { CSSProperties } from "react";

export type LegendShape = "dot" | "tick" | "line" | "dash" | "ring" | "bar";
export interface LegendItem {
  label: string;
  color: string;
  shape?: LegendShape;
}

export function Legend({ items }: { items: LegendItem[] }) {
  return (
    <ul className="legend">
      {items.map((item) => (
        <li key={item.label}>
          <span
            className="legend-key"
            data-shape={item.shape ?? "dot"}
            style={{ "--key": item.color } as CSSProperties}
          />
          {item.label}
        </li>
      ))}
    </ul>
  );
}
