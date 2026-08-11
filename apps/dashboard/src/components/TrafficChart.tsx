import { useLayoutEffect, useRef, useState } from "react";
import type { TimeSeries } from "../api/client";
import { formatCount, formatPercent } from "../api/format";
import { barPath, formatBucketLabel, labelledIndices, layoutChart, niceScale } from "./chart-geometry";

/**
 * Requests over time, split by outcome.
 *
 * The dashboard's other panels answer "what is true right now". This one answers
 * the question a number cannot: **is it getting worse?** A 96% success rate is
 * either fine or an emergency depending on whether the failures are spread over
 * the whole window or all arrived in the last four minutes, and the summary tile
 * renders both identically.
 *
 * Colors are the two validated slots for this surface — series blue and status
 * critical. The obvious green/red pair was measured and rejected: at deutan
 * simulation it separates by ΔE 4.1, so for a red-green colorblind reader the
 * two halves of every bar are the same color. Blue against the same red measures
 * 25.7. The legend and the data table carry identity independently of hue either
 * way, since color alone is never allowed to be the encoding.
 */
const SUCCESS_COLOR = "#3987e5";
const ERROR_COLOR = "#d03b3b";

const PLOT_HEIGHT = 140;
const MARGIN = { top: 8, right: 8, bottom: 20 };

/**
 * The gutter has to fit the widest y-axis label, which on a busy gateway is five
 * digits and a separator. A fixed width silently clips "10,000" to "0,000" —
 * an axis that is not merely ugly but wrong by a factor of ten.
 */
function axisGutter(maxTick: number): number {
  const characters = formatCount(maxTick).length;
  // 6px per character at the 10px monospace the labels are set in, plus the gap
  // between the label and the plot.
  return Math.max(28, characters * 6 + 10);
}

/** Measures the container, so the chart reflows instead of scrolling. */
function useElementWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return;

    const observer = new ResizeObserver(([entry]) => {
      if (entry !== undefined) setWidth(entry.contentRect.width);
    });
    observer.observe(element);
    setWidth(element.getBoundingClientRect().width);

    return () => observer.disconnect();
  }, []);

  return [ref, width];
}

export function TrafficChart({ series }: { series: TimeSeries }) {
  const [containerRef, containerWidth] = useElementWidth();
  const [hovered, setHovered] = useState<number | null>(null);

  const svgWidth = Math.max(240, containerWidth);
  // The scale decides the gutter and the gutter decides the plot width, so the
  // scale is resolved first. `niceScale` is pure, and `layoutChart` derives the
  // same answer from the same input.
  const peak = series.data.reduce((highest, bucket) => Math.max(highest, bucket.total), 0);
  const marginLeft = axisGutter(niceScale(peak).max);
  const plotWidth = Math.max(1, svgWidth - marginLeft - MARGIN.right);
  const { bars, yMax, yTicks } = layoutChart(series.data, plotWidth, PLOT_HEIGHT);

  const totals = series.data.reduce(
    (running, bucket) => ({
      requests: running.requests + bucket.total,
      errors: running.errors + bucket.errors,
    }),
    { requests: 0, errors: 0 },
  );

  const labelled = new Set(labelledIndices(bars.length));
  const active = hovered === null ? undefined : bars[hovered];

  return (
    <div className="rounded border border-slate-700 bg-slate-900 p-4">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <div className="text-xs text-slate-500">
          {formatCount(totals.requests)} requests
          {totals.requests > 0 && (
            <> · {formatPercent(totals.errors / totals.requests)} errors</>
          )}
        </div>
        {/* Two series, so a legend is not optional. */}
        <div className="flex items-center gap-4 text-xs text-slate-400">
          <Legend color={SUCCESS_COLOR} label="Successful" />
          <Legend color={ERROR_COLOR} label="Errors" />
        </div>
      </div>

      <div ref={containerRef} className="relative">
        <svg
          width="100%"
          height={PLOT_HEIGHT + MARGIN.top + MARGIN.bottom}
          viewBox={`0 0 ${svgWidth} ${PLOT_HEIGHT + MARGIN.top + MARGIN.bottom}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={`Requests per ${describeBucket(series.bucket_seconds)}. ${formatCount(
            totals.requests,
          )} requests, ${formatCount(totals.errors)} errors. Full figures in the data table below.`}
          onMouseLeave={() => setHovered(null)}
        >
          <g transform={`translate(${marginLeft},${MARGIN.top})`}>
            {/* Recessive grid: present enough to read a value against, quiet
                enough that it never competes with the marks. */}
            {yTicks.map((tick) => {
              const y = PLOT_HEIGHT - (tick / yMax) * PLOT_HEIGHT;
              return (
                <g key={tick}>
                  <line
                    x1={0}
                    x2={plotWidth}
                    y1={y}
                    y2={y}
                    stroke="#1e293b"
                    strokeWidth={1}
                    shapeRendering="crispEdges"
                  />
                  <text
                    x={-8}
                    y={y}
                    textAnchor="end"
                    dominantBaseline="middle"
                    className="fill-slate-500 font-mono text-[10px]"
                  >
                    {formatCount(tick)}
                  </text>
                </g>
              );
            })}

            {bars.map((bar) => (
              <g key={bar.bucketStart}>
                {bar.successRect !== null && (
                  <path d={barPath(bar.successRect)} fill={SUCCESS_COLOR} />
                )}
                {bar.errorRect !== null && <path d={barPath(bar.errorRect)} fill={ERROR_COLOR} />}
              </g>
            ))}

            {/* Hit bands span the full plot height and the full slot width, so a
                3px bar in a busy window is still reachable with a mouse. */}
            {bars.map((bar) => (
              <rect
                key={`hit-${bar.bucketStart}`}
                x={bar.hitX}
                y={0}
                width={bar.hitWidth}
                height={PLOT_HEIGHT}
                fill={hovered === bar.index ? "#ffffff" : "transparent"}
                fillOpacity={hovered === bar.index ? 0.06 : 0}
                onMouseEnter={() => setHovered(bar.index)}
              />
            ))}

            {bars.map((bar) =>
              labelled.has(bar.index) ? (
                <text
                  key={`label-${bar.bucketStart}`}
                  x={bar.hitX + bar.hitWidth / 2}
                  y={PLOT_HEIGHT + 14}
                  textAnchor={bar.index === 0 ? "start" : bar.index === bars.length - 1 ? "end" : "middle"}
                  className="fill-slate-500 font-mono text-[10px]"
                >
                  {formatBucketLabel(bar.bucketStart, series.bucket_seconds)}
                </text>
              ) : null,
            )}
          </g>
        </svg>

        {active !== undefined && (
          <Tooltip
            bar={active}
            bucketSeconds={series.bucket_seconds}
            // Pinned to the corner away from the cursor. A tooltip that follows
            // the pointer sits on top of the bars it is describing, which on a
            // dense chart hides the incident you are hovering to read.
            side={active.hitX + active.hitWidth / 2 > plotWidth / 2 ? "left" : "right"}
          />
        )}
      </div>

      {/* The chart's own data, reachable without a mouse and without color
          vision. Required, not a nicety. */}
      <details className="mt-3">
        <summary className="cursor-pointer text-xs text-slate-500 hover:text-slate-300">
          Show data table
        </summary>
        <div className="mt-2 max-h-56 overflow-y-auto rounded border border-slate-800">
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 bg-slate-800 text-slate-400">
              <tr>
                <th className="px-2 py-1 font-medium">Bucket start</th>
                <th className="px-2 py-1 text-right font-medium">Successful</th>
                <th className="px-2 py-1 text-right font-medium">Errors</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800 font-mono">
              {series.data.map((bucket) => (
                <tr key={bucket.bucket_start}>
                  <td className="px-2 py-1 text-slate-400">
                    {new Date(bucket.bucket_start).toLocaleString()}
                  </td>
                  <td className="px-2 py-1 text-right text-slate-300">
                    {formatCount(bucket.total - bucket.errors)}
                  </td>
                  <td className="px-2 py-1 text-right text-slate-300">
                    {formatCount(bucket.errors)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span
        aria-hidden="true"
        className="inline-block h-2.5 w-2.5 rounded-sm"
        style={{ backgroundColor: color }}
      />
      {label}
    </span>
  );
}

function Tooltip({
  bar,
  bucketSeconds,
  side,
}: {
  bar: { bucketStart: string; total: number; errors: number; successes: number };
  bucketSeconds: number;
  side: "left" | "right";
}) {
  return (
    <div
      className={`pointer-events-none absolute top-0 z-10 rounded border border-slate-600 bg-slate-950/95 px-2 py-1.5 text-xs shadow-lg ${
        side === "left" ? "left-0" : "right-0"
      }`}
    >
      <div className="font-mono text-[10px] text-slate-400">
        {formatBucketLabel(bar.bucketStart, bucketSeconds)} · {describeBucket(bucketSeconds)}
      </div>
      <div className="mt-1 font-mono text-slate-200">{formatCount(bar.total)} total</div>
      <div className="mt-0.5 flex gap-3 font-mono text-[11px]">
        {/* Labelled, so the split is readable without relying on the swatch
            colors — the same reason the legend and the data table exist. */}
        <span style={{ color: SUCCESS_COLOR }}>{formatCount(bar.successes)} ok</span>
        <span style={{ color: ERROR_COLOR }}>{formatCount(bar.errors)} err</span>
      </div>
    </div>
  );
}

function describeBucket(seconds: number): string {
  if (seconds >= 86_400) return `${seconds / 86_400}d bucket`;
  if (seconds >= 3_600) return `${seconds / 3_600}h bucket`;
  return `${seconds / 60}m bucket`;
}
