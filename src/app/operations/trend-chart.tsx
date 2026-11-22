"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

// Multi-line trend: tickets per 100 homes per month, one line per agency. Dataviz specs: 2px
// lines, >=8px end dots with a 2px surface ring, hairline grid, legend with line keys, direct
// end labels (with leader lines when they would collide), a crosshair that snaps to the nearest
// month (pointer and arrow keys) with a tooltip, and a table view next to it.

export type TrendSeries = { id: string; name: string; color: string; points: { month: string; value: number }[] };

const H = 260;
const M = { top: 16, right: 150, bottom: 28, left: 40 };
const monthLabel = (m: string) =>
  new Intl.DateTimeFormat("en-GB", { month: "short", timeZone: "UTC" }).format(new Date(`${m}-01T00:00:00Z`));

export function TrendChart({ series, months }: { series: TrendSeries[]; months: string[] }) {
  // Nothing to plot: say so instead of mounting an interactive chart with no positions.
  if (months.length === 0 || series.every((s) => s.points.length === 0)) {
    return <p className="rounded-md border border-dashed border-border p-6 text-center text-body-sm text-muted">No data for this period.</p>;
  }
  return <Plot series={series} months={months} />;
}

function Plot({ series, months }: { series: TrendSeries[]; months: string[] }) {
  const titleId = useId();
  const [active, setActive] = useState<number | null>(null);
  // Drawn at the container's real width (1:1), so text keeps its size instead of scaling.
  const boxRef = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(720);
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const observer = new ResizeObserver(([entry]) => setW(Math.max(320, Math.round(entry.contentRect.width))));
    observer.observe(box);
    return () => observer.disconnect();
  }, []);
  const max = Math.max(1, ...series.flatMap((s) => s.points.map((p) => p.value)));
  const top = Math.ceil(max);
  const ticks = Array.from({ length: top + 1 }, (_, i) => i).filter((t) => top <= 6 || t % 2 === 0);
  const x = (i: number) => M.left + (months.length === 1 ? 0 : (i / (months.length - 1)) * (W - M.left - M.right));
  const y = (v: number) => M.top + (1 - v / top) * (H - M.top - M.bottom);
  const at = (s: TrendSeries, i: number) => s.points.find((p) => p.month === months[i]);

  // End labels: at each line's last point, pushed apart to at least 14px, with a leader line.
  const ends = series
    .map((s) => {
      const last = s.points[s.points.length - 1];
      return last ? { s, last, ly: y(last.value), py: y(last.value), px: x(months.indexOf(last.month)) } : null;
    })
    .filter((e): e is NonNullable<typeof e> => e !== null)
    .sort((a, b) => a.ly - b.ly);
  for (let i = 1; i < ends.length; i++) ends[i].ly = Math.max(ends[i].ly, ends[i - 1].ly + 14);

  const snap = (event: PointerEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const px = ((event.clientX - box.left) / box.width) * W;
    let best = 0;
    months.forEach((_, i) => {
      if (Math.abs(x(i) - px) < Math.abs(x(best) - px)) best = i;
    });
    setActive(best);
  };
  const onKey = (event: KeyboardEvent<SVGSVGElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    setActive((i) => Math.min(months.length - 1, Math.max(0, (i ?? months.length - 1) + (event.key === "ArrowRight" ? 1 : -1))));
  };

  return (
    <figure className="space-y-2">
      <figcaption id={titleId} className="sr-only">
        Tickets per 100 homes per month, by agency. Use the arrow keys to read each month.
      </figcaption>
      {/* Legend: line keys, text in text tokens. */}
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-label text-muted" aria-hidden="true">
        {series.map((s) => (
          <li key={s.id} className="flex items-center gap-1.5">
            <span className="inline-block h-0.5 w-4 rounded" style={{ background: s.color }} />
            {s.name}
          </li>
        ))}
      </ul>
      <div ref={boxRef} className="relative">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          width={W}
          height={H}
          role="img"
          aria-labelledby={titleId}
          tabIndex={0}
          className="block max-w-full touch-none overflow-visible outline-offset-4 focus-visible:outline-2 focus-visible:outline-accent"
          onPointerMove={snap}
          onPointerLeave={() => setActive(null)}
          onFocus={() => setActive(Math.max(0, months.length - 1))}
          onBlur={() => setActive(null)}
          onKeyDown={onKey}
        >
          {ticks.map((t) => (
            <g key={t}>
              <line x1={M.left} x2={W - M.right} y1={y(t)} y2={y(t)} style={{ stroke: "var(--border)" }} strokeWidth={1} />
              <text x={M.left - 8} y={y(t)} dy="0.32em" textAnchor="end" className="fill-muted text-[11px] tabular-nums">
                {t}
              </text>
            </g>
          ))}
          {months.map((m, i) =>
            i % 2 === 0 || i === months.length - 1 ? (
              <text key={m} x={x(i)} y={H - 8} textAnchor="middle" className="fill-muted text-[11px]">
                {monthLabel(m)}
              </text>
            ) : null,
          )}
          {active !== null && (
            <line x1={x(active)} x2={x(active)} y1={M.top} y2={H - M.bottom} style={{ stroke: "var(--border-strong)" }} strokeWidth={1} />
          )}
          {series.map((s) => {
            // A gap in the data (an agency that joined later) breaks the line instead of bridging it.
            const d = months
              .map((m, i) => {
                const p = at(s, i);
                if (!p) return "";
                const prev = i > 0 && at(s, i - 1);
                return `${prev ? "L" : "M"}${x(i)},${y(p.value)}`;
              })
              .join("");
            // Colors go in style: CSS variables don't resolve in SVG presentation attributes.
            return <path key={s.id} d={d} fill="none" style={{ stroke: s.color }} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />;
          })}
          {ends.map(({ s, last, ly, py, px }) => (
            <g key={s.id}>
              <circle cx={px} cy={py} r={4} style={{ fill: s.color, stroke: "var(--surface)" }} strokeWidth={2} />
              {Math.abs(ly - py) > 1 && (
                <line x1={px + 6} y1={py} x2={px + 14} y2={ly} style={{ stroke: "var(--border-strong)" }} strokeWidth={1} />
              )}
              <text x={px + 16} y={ly} dy="0.32em" className="fill-foreground text-[12px]">
                <tspan className="tabular-nums">{last.value.toFixed(1)}</tspan>
                <tspan className="fill-muted"> {s.name}</tspan>
              </text>
            </g>
          ))}
          {active !== null &&
            series.map((s) => {
              const p = at(s, active);
              return p ? (
                <circle key={s.id} cx={x(active)} cy={y(p.value)} r={4} style={{ fill: s.color, stroke: "var(--surface)" }} strokeWidth={2} />
              ) : null;
            })}
        </svg>
        {active !== null && (
          <div
            role="status"
            className="pointer-events-none absolute top-2 rounded-md border border-border bg-surface px-3 py-2 text-label shadow-panel"
            style={{ left: `${Math.min(70, (x(active) / W) * 100)}%` }}
          >
            <p className="mb-1 font-medium text-foreground">
              {new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }).format(
                new Date(`${months[active]}-01T00:00:00Z`),
              )}
            </p>
            {series.map((s) => {
              const p = at(s, active);
              return (
                <p key={s.id} className="flex items-center gap-2 text-muted">
                  <span className="inline-block h-0.5 w-3 rounded" style={{ background: s.color }} />
                  {s.name}
                  <span className="ml-auto pl-3 font-mono tabular-nums text-foreground">{p ? p.value.toFixed(2) : "no data"}</span>
                </p>
              );
            })}
          </div>
        )}
      </div>
    </figure>
  );
}
