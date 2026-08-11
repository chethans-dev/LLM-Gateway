/**
 * Chart geometry, as arithmetic.
 *
 * Kept out of the component and free of React so the parts that are easy to get
 * silently wrong — a bar taller than the plot, an error count that rounds to
 * nothing, a bucket dropped off the right edge — are unit-testable rather than
 * eyeballed in a browser.
 *
 * There is no charting library here for the same reason there is no ORM in the
 * hot path: one stacked column chart is roughly this file, and a dependency that
 * ships a canvas renderer, a locale bundle and its own theming system to draw it
 * is not a trade worth making.
 */

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** Corner radius for the end away from the baseline. 0 for square. */
  readonly radius: number;
}

export interface ChartBucket {
  readonly bucket_start: string;
  readonly total: number;
  readonly errors: number;
}

export interface ChartBar {
  readonly index: number;
  readonly bucketStart: string;
  readonly total: number;
  readonly errors: number;
  readonly successes: number;
  /** Full-height band for hover. Bigger than the marks, per interaction specs. */
  readonly hitX: number;
  readonly hitWidth: number;
  readonly errorRect: Rect | null;
  readonly successRect: Rect | null;
}

export interface ChartLayout {
  readonly bars: readonly ChartBar[];
  readonly yMax: number;
  readonly yTicks: readonly number[];
}

/** Surface gap between adjacent bars and between stacked segments. */
const GAP = 2;
/**
 * A bucket with one error in ten thousand requests must still show a red mark.
 * Rounded to a sub-pixel sliver it would render as nothing, and "one error" and
 * "no errors" are the exact pair this chart exists to distinguish. The floor
 * overstates tiny counts by a pixel or two; the tooltip carries the real number.
 */
const MIN_SEGMENT = 2;
const MAX_RADIUS = 4;

/**
 * A round number at or above the peak, so gridlines land on values a person
 * would say out loud. Steps of 1, 2 or 5 times a power of ten.
 */
export function niceScale(peak: number): { max: number; ticks: number[] } {
  if (!Number.isFinite(peak) || peak <= 0) return { max: 1, ticks: [0, 1] };

  // Two divisions: a midline and a top line, no more. A dense grid competes with
  // the marks it exists to support. Solving for the step rather than the max is
  // what keeps the midline on a round number too — an axis labelled 0/12.5/25 is
  // a worse axis than one labelled 0/20/40, even though it fits tighter.
  const target = peak / 2;
  const magnitude = 10 ** Math.floor(Math.log10(target));
  const step =
    [1, 2, 2.5, 5].map((multiple) => multiple * magnitude).find((candidate) => candidate >= target) ??
    10 * magnitude;

  // Counts are integers, so the labels must be too.
  const wholeStep = Math.max(1, Math.ceil(step));

  return { max: wholeStep * 2, ticks: [0, wholeStep, wholeStep * 2] };
}

export function layoutChart(
  buckets: readonly ChartBucket[],
  plotWidth: number,
  plotHeight: number,
): ChartLayout {
  const peak = buckets.reduce((highest, bucket) => Math.max(highest, bucket.total), 0);
  const { max: yMax, ticks: yTicks } = niceScale(peak);

  if (buckets.length === 0 || plotWidth <= 0 || plotHeight <= 0) {
    return { bars: [], yMax, yTicks };
  }

  const slot = plotWidth / buckets.length;
  const barWidth = Math.max(1, slot - GAP);

  const bars = buckets.map((bucket, index): ChartBar => {
    const slotX = index * slot;
    const x = slotX + (slot - barWidth) / 2;
    const successes = Math.max(0, bucket.total - bucket.errors);

    // Both segments present means one gap between them, and the gap comes out of
    // the stack's budget rather than pushing the bar past the top of the plot.
    const bothPresent = bucket.errors > 0 && successes > 0;
    const available = Math.max(0, plotHeight - (bothPresent ? GAP : 0));

    // Scale first, then lift off zero. In that order the floor can only ever
    // raise a mark into visibility, never shrink a real one.
    const scale = (value: number) => (value / yMax) * available;
    let errorHeight = bucket.errors > 0 ? Math.max(MIN_SEGMENT, scale(bucket.errors)) : 0;
    let successHeight = successes > 0 ? Math.max(MIN_SEGMENT, scale(successes)) : 0;

    // The floor can push a full-height bar a pixel or two over. Take the excess
    // out of the larger segment: shrinking both proportionally would pull the
    // floored one straight back under the floor, undoing the only thing it is
    // there for.
    const excess = errorHeight + successHeight - available;
    if (excess > 0) {
      if (errorHeight >= successHeight) errorHeight = Math.max(0, errorHeight - excess);
      else successHeight = Math.max(0, successHeight - excess);
    }

    // Errors sit on the baseline. Only the baseline-anchored segment of a stack
    // can be compared across columns by eye, and comparing errors over time is
    // the question this chart is on the page to answer.
    const errorY = plotHeight - errorHeight;
    const successY = errorY - (bothPresent ? GAP : 0) - successHeight;

    const topSegmentIsSuccess = successHeight > 0;
    const round = (width: number, height: number) =>
      Math.min(MAX_RADIUS, width / 2, Math.max(0, height / 2));

    return {
      index,
      bucketStart: bucket.bucket_start,
      total: bucket.total,
      errors: bucket.errors,
      successes,
      hitX: slotX,
      hitWidth: slot,
      errorRect:
        errorHeight > 0
          ? {
              x,
              y: errorY,
              width: barWidth,
              height: errorHeight,
              radius: topSegmentIsSuccess ? 0 : round(barWidth, errorHeight),
            }
          : null,
      successRect:
        successHeight > 0
          ? {
              x,
              y: successY,
              width: barWidth,
              height: successHeight,
              radius: round(barWidth, successHeight),
            }
          : null,
    };
  });

  return { bars, yMax, yTicks };
}

/**
 * An SVG path for a rectangle rounded on the top two corners only.
 *
 * `rx` on a `<rect>` rounds all four, which detaches the bar from its baseline
 * and reads as a floating pill rather than a measured quantity.
 */
export function barPath(rect: Rect): string {
  const { x, y, width, height, radius } = rect;
  const r = Math.min(radius, width / 2, height);

  if (r <= 0) return `M${x},${y}h${width}v${height}h${-width}Z`;

  return [
    `M${x},${y + height}`,
    `V${y + r}`,
    `A${r},${r} 0 0 1 ${x + r},${y}`,
    `H${x + width - r}`,
    `A${r},${r} 0 0 1 ${x + width},${y + r}`,
    `V${y + height}`,
    "Z",
  ].join("");
}

/**
 * Which bars get an x-axis label.
 *
 * First, last and the middle — never one per bar. Sixty timestamps along an axis
 * overlap into a grey smear that reads as decoration.
 */
export function labelledIndices(count: number): readonly number[] {
  if (count <= 0) return [];
  if (count <= 2) return Array.from({ length: count }, (_, i) => i);
  return [0, Math.floor((count - 1) / 2), count - 1];
}

/** Bucket width decides whether a label needs a date or just a clock time. */
export function formatBucketLabel(iso: string, bucketSeconds: number): string {
  const date = new Date(iso);
  if (bucketSeconds >= 86_400) {
    return date.toLocaleDateString([], { month: "short", day: "numeric" });
  }
  if (bucketSeconds >= 3_600) {
    return date.toLocaleString([], { month: "short", day: "numeric", hour: "numeric" });
  }
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
