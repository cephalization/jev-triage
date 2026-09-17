import { useState } from "react";

/**
 * Small inline-SVG charts following the dataviz method: thin marks, 4px rounded data ends,
 * hairline recessive axes, text in text tokens, a hover tooltip on every mark, one axis.
 */

const SURFACE_GAP = 2;
const AXIS = "currentColor";

export interface BarDatum {
  label: string;
  value: number;
  /** Optional secondary marker (e.g. mean confidence) drawn as a dot. */
  marker?: number | null;
  hint?: string;
}

function useTip() {
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null);
  return {
    tip,
    show: (e: React.MouseEvent, text: string) => setTip({ x: e.clientX, y: e.clientY, text }),
    hide: () => setTip(null),
  };
}

function Tip({ tip }: { tip: { x: number; y: number; text: string } | null }) {
  if (!tip) return null;
  return (
    <div
      className="pointer-events-none fixed z-50 rounded-md border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md"
      style={{ left: tip.x + 12, top: tip.y + 12 }}
    >
      {tip.text}
    </div>
  );
}

/** Horizontal bars: one series, one hue, label at the tip. */
export function HBars({
  data,
  color = "#2a78d6",
  format = (v: number) => String(v),
  width = 360,
}: {
  data: BarDatum[];
  color?: string;
  format?: (v: number) => string;
  width?: number;
}) {
  const { tip, show, hide } = useTip();
  const rowH = 22;
  const barH = 12;
  const labelW = 96;
  const valueW = 44;
  const max = Math.max(1, ...data.map((d) => d.value));
  const plotW = width - labelW - valueW;
  const height = data.length * rowH + 4;
  return (
    <div className="relative">
      <svg width="100%" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="bar chart">
        {data.map((d, i) => {
          const y = i * rowH + (rowH - barH) / 2;
          const w = Math.max(0, (d.value / max) * plotW - SURFACE_GAP);
          return (
            <g
              key={d.label}
              onMouseMove={(e) => show(e, d.hint ?? `${d.label}: ${format(d.value)}`)}
              onMouseLeave={hide}
            >
              <rect x={0} y={i * rowH} width={width} height={rowH} fill="transparent" />
              <text
                x={labelW - 8}
                y={y + barH - 2}
                textAnchor="end"
                fontSize={11}
                fill={AXIS}
                className="text-foreground"
              >
                {d.label}
              </text>
              <line
                x1={labelW}
                x2={labelW}
                y1={y - 2}
                y2={y + barH + 2}
                stroke={AXIS}
                strokeOpacity={0.25}
              />
              {w > 0 && <path d={roundedRight(labelW, y, w, barH, 4)} fill={color} />}
              <text
                x={labelW + w + 6}
                y={y + barH - 2}
                fontSize={11}
                fill={AXIS}
                className="text-muted-foreground"
              >
                {format(d.value)}
              </text>
            </g>
          );
        })}
      </svg>
      <Tip tip={tip} />
    </div>
  );
}

/** Columns with an optional dot marker per column (two encodings → legend is rendered by caller). */
export function Columns({
  data,
  color = "#2a78d6",
  markerColor = "#eb6834",
  format = (v: number) => String(v),
  max: maxIn,
  width = 360,
  height = 140,
}: {
  data: BarDatum[];
  color?: string;
  markerColor?: string;
  format?: (v: number) => string;
  max?: number;
  width?: number;
  height?: number;
}) {
  const { tip, show, hide } = useTip();
  const padL = 30;
  const padB = 18;
  const padT = 6;
  const plotH = height - padB - padT;
  const plotW = width - padL - 4;
  const max = maxIn ?? Math.max(1, ...data.map((d) => Math.max(d.value, d.marker ?? 0)));
  const slot = data.length > 0 ? plotW / data.length : plotW;
  const colW = Math.min(24, Math.max(3, slot - SURFACE_GAP * 2));
  const y = (v: number) => padT + plotH - (v / max) * plotH;
  const ticks = [0, 0.5, 1].map((t) => t * max);
  return (
    <div className="relative">
      <svg width="100%" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="column chart">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={padL} x2={width - 4} y1={y(t)} y2={y(t)} stroke={AXIS} strokeOpacity={0.12} />
            <text
              x={padL - 4}
              y={y(t) + 3}
              textAnchor="end"
              fontSize={9}
              fill={AXIS}
              className="text-muted-foreground"
            >
              {format(t)}
            </text>
          </g>
        ))}
        {data.map((d, i) => {
          const x = padL + i * slot + (slot - colW) / 2;
          const h = Math.max(0, (d.value / max) * plotH);
          return (
            <g
              key={d.label}
              onMouseMove={(e) => show(e, d.hint ?? `${d.label}: ${format(d.value)}`)}
              onMouseLeave={hide}
            >
              <rect
                x={padL + i * slot}
                y={padT}
                width={slot}
                height={plotH + padB}
                fill="transparent"
              />
              {h > 0 && <path d={roundedTop(x, y(d.value), colW, h, 4)} fill={color} />}
              {d.marker != null && (
                <circle
                  cx={x + colW / 2}
                  cy={y(d.marker)}
                  r={4}
                  fill={markerColor}
                  stroke="var(--background)"
                  strokeWidth={2}
                />
              )}
              {data.length <= 12 && (
                <text
                  x={x + colW / 2}
                  y={height - 5}
                  textAnchor="middle"
                  fontSize={9}
                  fill={AXIS}
                  className="text-muted-foreground"
                >
                  {d.label}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <Tip tip={tip} />
    </div>
  );
}

export function Legend({
  items,
}: {
  items: { label: string; color: string; shape?: "bar" | "dot" }[];
}) {
  return (
    <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
      {items.map((i) => (
        <span key={i.label} className="inline-flex items-center gap-1">
          <span
            className={i.shape === "dot" ? "size-2 rounded-full" : "h-2 w-3 rounded-sm"}
            style={{ backgroundColor: i.color }}
          />
          {i.label}
        </span>
      ))}
    </div>
  );
}

function roundedRight(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.min(r, w, h / 2);
  return `M${x},${y} h${w - rr} a${rr},${rr} 0 0 1 ${rr},${rr} v${h - 2 * rr} a${rr},${rr} 0 0 1 -${rr},${rr} h-${w - rr} z`;
}

function roundedTop(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.min(r, h, w / 2);
  return `M${x},${y + h} v-${h - rr} a${rr},${rr} 0 0 1 ${rr},-${rr} h${w - 2 * rr} a${rr},${rr} 0 0 1 ${rr},${rr} v${h - rr} z`;
}
