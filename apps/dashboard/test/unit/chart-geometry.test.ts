import { describe, expect, it } from "vitest";
import {
  barPath,
  labelledIndices,
  layoutChart,
  niceScale,
  type ChartBucket,
} from "../../src/components/chart-geometry.js";

/**
 * The chart's arithmetic, tested without a browser.
 *
 * These are the failures that are invisible in a screenshot taken on a good day:
 * a bar that overflows its plot only when errors spike, a single error rounded
 * away to nothing, a bucket dropped off the right edge. Each one turns the chart
 * into a confidently wrong picture, which is worse than no chart.
 */

const PLOT_WIDTH = 600;
const PLOT_HEIGHT = 100;

function buckets(...counts: readonly (readonly [number, number])[]): ChartBucket[] {
  return counts.map(([total, errors], index) => ({
    bucket_start: new Date(Date.UTC(2026, 7, 1, 12, index)).toISOString(),
    total,
    errors,
  }));
}

describe("niceScale", () => {
  it("rounds the axis up to a number a person would say", () => {
    expect(niceScale(87).max).toBe(100);
    expect(niceScale(4).max).toBe(4);
    expect(niceScale(1_100).max).toBe(2_000);
  });

  it("keeps the midline on a whole number", () => {
    // Request counts are integers. An axis labelled 0 / 12.5 / 25 fits tighter
    // than 0 / 20 / 40 and is still the worse axis.
    for (const peak of [1, 3, 4, 7, 23, 51, 87, 640, 9_001]) {
      for (const tick of niceScale(peak).ticks) {
        expect(Number.isInteger(tick)).toBe(true);
      }
    }
  });

  it("never puts the peak above the axis", () => {
    // A bar taller than its own scale is the most embarrassing possible bug.
    for (const peak of [1, 3, 7, 12, 49, 51, 99, 101, 1_234, 99_999]) {
      expect(niceScale(peak).max).toBeGreaterThanOrEqual(peak);
    }
  });

  it("survives an empty window", () => {
    // No traffic is a normal state, not an error state.
    expect(niceScale(0)).toEqual({ max: 1, ticks: [0, 1] });
    expect(niceScale(Number.NaN).max).toBe(1);
  });

  it("puts a tick at zero and at the top", () => {
    const { max, ticks } = niceScale(87);
    expect(ticks[0]).toBe(0);
    expect(ticks[ticks.length - 1]).toBe(max);
  });
});

describe("layoutChart", () => {
  it("emits one bar per bucket, including the empty ones", () => {
    // The gateway sends a gap-filled spine precisely so quiet periods are
    // visible; silently skipping them here would undo that.
    const layout = layoutChart(buckets([10, 0], [0, 0], [4, 1]), PLOT_WIDTH, PLOT_HEIGHT);

    expect(layout.bars).toHaveLength(3);
    expect(layout.bars[1]?.errorRect).toBeNull();
    expect(layout.bars[1]?.successRect).toBeNull();
  });

  it("keeps every bar inside the plot", () => {
    const layout = layoutChart(
      buckets([100, 0], [100, 100], [100, 50], [1, 1], [63, 7]),
      PLOT_WIDTH,
      PLOT_HEIGHT,
    );

    for (const bar of layout.bars) {
      for (const rect of [bar.errorRect, bar.successRect]) {
        if (rect === null) continue;
        expect(rect.y).toBeGreaterThanOrEqual(-0.001);
        expect(rect.y + rect.height).toBeLessThanOrEqual(PLOT_HEIGHT + 0.001);
        expect(rect.x + rect.width).toBeLessThanOrEqual(PLOT_WIDTH + 0.001);
      }
    }
  });

  it("anchors errors to the baseline", () => {
    // Only the baseline-anchored segment can be compared across columns by eye,
    // and comparing errors over time is what the chart is for.
    const layout = layoutChart(buckets([10, 3]), PLOT_WIDTH, PLOT_HEIGHT);
    const bar = layout.bars[0];

    expect(bar?.errorRect?.y ?? 0 + (bar?.errorRect?.height ?? 0)).toBeLessThanOrEqual(PLOT_HEIGHT);
    expect((bar?.errorRect?.y ?? 0) + (bar?.errorRect?.height ?? 0)).toBeCloseTo(PLOT_HEIGHT, 5);
    expect(bar?.successRect?.y ?? Infinity).toBeLessThan(bar?.errorRect?.y ?? 0);
  });

  it("shows a single error among thousands rather than rounding it away", () => {
    // The whole reason to look at this chart is to catch the first few errors.
    const layout = layoutChart(buckets([10_000, 1]), PLOT_WIDTH, PLOT_HEIGHT);

    expect(layout.bars[0]?.errorRect?.height ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("does not invent an error mark when there are none", () => {
    // The visibility floor must only ever lift a real value off zero.
    const layout = layoutChart(buckets([500, 0]), PLOT_WIDTH, PLOT_HEIGHT);

    expect(layout.bars[0]?.errorRect).toBeNull();
    expect(layout.bars[0]?.successRect).not.toBeNull();
  });

  it("derives successes rather than trusting a second field", () => {
    const layout = layoutChart(buckets([10, 4]), PLOT_WIDTH, PLOT_HEIGHT);

    expect(layout.bars[0]?.successes).toBe(6);
  });

  it("handles an all-errors bucket", () => {
    const layout = layoutChart(buckets([8, 8]), PLOT_WIDTH, PLOT_HEIGHT);

    expect(layout.bars[0]?.successRect).toBeNull();
    // With nothing above it, the error segment carries the rounded end.
    expect(layout.bars[0]?.errorRect?.radius ?? 0).toBeGreaterThan(0);
  });

  it("rounds only the segment on top of the stack", () => {
    const layout = layoutChart(buckets([10, 3]), PLOT_WIDTH, PLOT_HEIGHT);

    expect(layout.bars[0]?.errorRect?.radius).toBe(0);
    expect(layout.bars[0]?.successRect?.radius ?? 0).toBeGreaterThan(0);
  });

  it("leaves a gap between the two segments", () => {
    const layout = layoutChart(buckets([100, 50]), PLOT_WIDTH, PLOT_HEIGHT);
    const bar = layout.bars[0];
    const gap = (bar?.errorRect?.y ?? 0) - ((bar?.successRect?.y ?? 0) + (bar?.successRect?.height ?? 0));

    expect(gap).toBeCloseTo(2, 5);
  });

  it("gives every bar a hit target at least as wide as the bar", () => {
    // Interaction spec: the hover band is bigger than the mark, so a 3px bar is
    // still reachable with a mouse.
    const layout = layoutChart(buckets(...Array.from({ length: 60 }, () => [5, 0] as const)), PLOT_WIDTH, PLOT_HEIGHT);

    for (const bar of layout.bars) {
      expect(bar.hitWidth).toBeGreaterThanOrEqual(bar.successRect?.width ?? 0);
    }
    // And the bands tile the plot without gaps.
    expect(layout.bars[59]!.hitX + layout.bars[59]!.hitWidth).toBeCloseTo(PLOT_WIDTH, 5);
  });

  it("still produces bars when the window is narrow", () => {
    // 60 one-minute buckets on a phone.
    const layout = layoutChart(buckets(...Array.from({ length: 60 }, () => [5, 1] as const)), 120, 80);

    expect(layout.bars).toHaveLength(60);
    for (const bar of layout.bars) {
      expect(bar.successRect?.width ?? 1).toBeGreaterThan(0);
    }
  });

  it("returns no bars, but a usable scale, for an empty series", () => {
    const layout = layoutChart([], PLOT_WIDTH, PLOT_HEIGHT);

    expect(layout.bars).toEqual([]);
    expect(layout.yMax).toBe(1);
  });

  it("does not divide by zero before the container has been measured", () => {
    // React renders once before the ResizeObserver reports a width.
    expect(() => layoutChart(buckets([10, 1]), 0, 0)).not.toThrow();
    expect(layoutChart(buckets([10, 1]), 0, 0).bars).toEqual([]);
  });
});

describe("barPath", () => {
  it("closes the path", () => {
    expect(barPath({ x: 0, y: 0, width: 10, height: 10, radius: 4 })).toMatch(/Z$/);
  });

  it("emits a plain rectangle when the radius is zero", () => {
    expect(barPath({ x: 1, y: 2, width: 10, height: 5, radius: 0 })).toBe("M1,2h10v5h-10Z");
  });

  it("never rounds more than the mark can carry", () => {
    // A 2px sliver with a 4px radius produces an arc that folds back on itself.
    const path = barPath({ x: 0, y: 98, width: 3, height: 2, radius: 4 });

    expect(path).not.toContain("NaN");
    expect(path).toContain("A1.5,1.5");
  });
});

describe("labelledIndices", () => {
  it("labels first, middle and last — never every bar", () => {
    expect(labelledIndices(60)).toEqual([0, 29, 59]);
  });

  it("handles tiny series", () => {
    expect(labelledIndices(0)).toEqual([]);
    expect(labelledIndices(1)).toEqual([0]);
    expect(labelledIndices(2)).toEqual([0, 1]);
    expect(labelledIndices(3)).toEqual([0, 1, 2]);
  });
});
