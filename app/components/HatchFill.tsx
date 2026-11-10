const HATCH_GAP = 4;
const TOP_OPACITY = 0.55;
const BOTTOM_OPACITY = 0.04;

/** Vertical hairlines that fade toward the baseline; fill an area with `url(#id)`. */
export function HatchFill({
  id,
  color,
  height,
}: {
  id: string;
  color: string;
  height: number;
}) {
  const fade = `${id}-fade`;
  return (
    <defs>
      <linearGradient id={fade} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor={color} stopOpacity={TOP_OPACITY} />
        <stop offset="1" stopColor={color} stopOpacity={BOTTOM_OPACITY} />
      </linearGradient>
      <pattern
        id={id}
        width={HATCH_GAP}
        height={height}
        patternUnits="userSpaceOnUse"
      >
        <rect width={1} height={height} fill={`url(#${fade})`} />
      </pattern>
    </defs>
  );
}
