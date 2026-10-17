import type { FootprintBar } from "../../../core/types.js";
import { SIZE_BUCKET_COUNT_V1 } from "../../../core/analysis/calc/ta.js";
import type { IndicatorDefinition, IndicatorDrawContext, IndicatorPlotStyle, IndicatorSettings } from "../types.js";
import { defaultPaneSettings, drawMultiSeries, prepareMultiSeries, simpleHeader, standardAppearanceFields, stringSetting, visibleIndexRange, type PlotSeries, type SeriesPoint } from "./taShared.js";
import { uiColor } from "../../../core/ui/seriesPalette.js";
import { incrementPerformanceCounter } from "../../../core/performanceTelemetry.js";
import { indicatorSeriesMutation } from "../seriesMutationSummary.js";

export interface CvdIndicatorSettings extends IndicatorSettings {
  plotStyle: IndicatorPlotStyle;
  lineWidth: number;
  lineColor: string;
  retailColor: string;
  midColor: string;
  whaleColor: string;
  bucketMode: "total" | "preset" | "custom";
  customBuckets: string;
  showScaleLabel?: boolean;
  showLastValueLabel?: boolean;
  showReadout?: boolean;
  showAxisTicks?: boolean;
  showPlotLabel: boolean;
}

interface BucketGroup {
  key: string;
  label: string;
  color: string;
  indices: readonly number[] | null;
}

const RETAIL_BUCKETS = Object.freeze([0, 1]);
const MID_BUCKETS = Object.freeze([2, 3, 4]);
const WHALE_BUCKETS = Object.freeze([5, 6, 7, 8, 9]);

interface CvdIncrementalState {
  instance: object;
  seriesRevision: number;
  structureRevision: number;
  start: number;
  end: number;
  lastBarStart: number | undefined;
  lastContributions: number[];
  plotSeries: PlotSeries[];
  prepared: ReturnType<typeof prepareMultiSeries>;
}

const cvdIncrementalStates = new WeakMap<object, Map<string, CvdIncrementalState>>();

function prepareCvdData(ctx: IndicatorDrawContext<CvdIndicatorSettings>) {
  const { start, end } = visibleIndexRange(ctx);
  const bars = ctx.series.listReadonly();
  const groups = groupsForSettings(ctx.settings);
  const lastIndex = bars.length - 1;
  const lastBar = lastIndex >= 0 ? bars[lastIndex] : undefined;
  let perSeries = cvdIncrementalStates.get(ctx.series);
  if (!perSeries) {
    perSeries = new Map();
    cvdIncrementalStates.set(ctx.series, perSeries);
  }
  const cached = perSeries.get(ctx.instance.id);
  if (cached?.seriesRevision === ctx.series.revision && cached.instance === ctx.instance && cached.start === start && cached.end === end) return cached.prepared;

  const mutation = indicatorSeriesMutation(ctx.series);
  const canReuse = cached
    && cached.instance === ctx.instance
    && cached.structureRevision === ctx.series.structureRevision
    && cached.start === start
    && cached.end === end
    && cached.lastBarStart === lastBar?.startTime
    && cached.plotSeries.length === groups.length
    && groups.every((group, index) => cached.plotSeries[index]?.key === group.key);

  if (canReuse && (mutation.kind === "tail" || mutation.kind === "metadata")) {
    if (mutation.kind === "tail" && lastBar) {
      const nextContributions = groups.map((group) => deltaForBar(lastBar, group.indices));
      if (lastIndex >= start && lastIndex < end) {
        for (let i = 0; i < cached.plotSeries.length; i++) {
          const points = cached.plotSeries[i].points;
          const point = points[points.length - 1];
          if (point?.index === lastIndex && point.value !== null) point.value += nextContributions[i] - cached.lastContributions[i];
        }
        cached.prepared = prepareMultiSeries(ctx, cached.plotSeries, { scaleMode: "signed-zero", baseline: 0 });
      }
      cached.lastContributions = nextContributions;
    }
    cached.seriesRevision = ctx.series.revision;
    incrementPerformanceCounter("indicator.incremental.hit.cvd");
    return cached.prepared;
  }

  const plotSeries: PlotSeries[] = groups.map((group) => ({
    key: group.key,
    label: group.label,
    color: group.color,
    style: ctx.settings.plotStyle,
    points: cumulativePoints(bars, start, end, group.indices),
  }));
  const prepared = prepareMultiSeries(ctx, plotSeries, { scaleMode: "signed-zero", baseline: 0 });
  perSeries.set(ctx.instance.id, {
    instance: ctx.instance,
    seriesRevision: ctx.series.revision,
    structureRevision: ctx.series.structureRevision,
    start, end, lastBarStart: lastBar?.startTime,
    lastContributions: groups.map((group) => deltaForBar(lastBar, group.indices)),
    plotSeries, prepared,
  });
  incrementPerformanceCounter("indicator.incremental.full.cvd");
  return prepared;
}

function groupsForSettings(settings: CvdIndicatorSettings): BucketGroup[] {
  const mode = settings.bucketMode ?? "preset";
  if (mode === "total") return [{ key: "total", label: "CVD", color: stringSetting(settings, "lineColor", uiColor.info), indices: null }];
  if (mode === "custom") {
    const indices = parseBucketIndices(settings.customBuckets);
    return [{ key: "custom", label: `CVD ${indices.map((item) => item + 1).join("/") || "all"}`, color: stringSetting(settings, "lineColor", uiColor.info), indices: indices.length ? indices : null }];
  }
  return [
    { key: "retail", label: "Retail <10k", color: stringSetting(settings, "retailColor", uiColor.info), indices: RETAIL_BUCKETS },
    { key: "mid", label: "Mid 10k-100k", color: stringSetting(settings, "midColor", uiColor.warn), indices: MID_BUCKETS },
    { key: "whale", label: "Whale 100k+", color: stringSetting(settings, "whaleColor", uiColor.sell), indices: WHALE_BUCKETS },
  ];
}

function cumulativePoints(bars: readonly FootprintBar[], start: number, end: number, indices: readonly number[] | null): SeriesPoint[] {
  let cumulative = 0;
  for (let i = 0; i < start; i++) cumulative += deltaForBar(bars[i], indices);
  const points: SeriesPoint[] = [];
  for (let i = start; i < end; i++) {
    const bar = bars[i];
    if (!bar) continue;
    const delta = deltaForBar(bar, indices);
    cumulative += delta;
    points.push({ index: i, time: bar.startTime, value: cumulative });
  }
  return points;
}

function deltaForBar(bar: FootprintBar | undefined, indices: readonly number[] | null): number {
  if (!bar) return 0;
  if (!indices) return bar.delta;
  const buckets = bar.deltaBySize;
  if (!buckets?.length) return bar.delta;
  let sum = 0;
  for (const index of indices) {
    const value = buckets[index];
    if (Number.isFinite(value)) sum += value;
  }
  return sum;
}

function parseBucketIndices(value: unknown): number[] {
  if (typeof value !== "string") return [];
  return [...new Set(value.split(/[,\s]+/).map((item) => Math.floor(Number(item) - 1)).filter((item) => item >= 0 && item < SIZE_BUCKET_COUNT_V1))];
}

export const cvdIndicatorDefinition: IndicatorDefinition<CvdIndicatorSettings> = {
  type: "cvd",
  name: "CVD",
  category: "flow",
  defaultPane: "separate",
  canOverlay: false,
  defaultPlacement: "separate-pane",
  supportedPlacements: ["separate-pane"],
  paneHeight: 116,
  defaultSettings: () => defaultPaneSettings({
    plotStyle: "line",
    lineWidth: 2,
    lineColor: uiColor.info,
    retailColor: uiColor.info,
    midColor: uiColor.warn,
    whaleColor: uiColor.sell,
    bucketMode: "preset",
    customBuckets: "1,2,3",
    showScaleLabel: true,
  }) as CvdIndicatorSettings,
  settingsSchema: {
    sections: [
      {
        title: "Buckets",
        titleKey: "indicator.cvd.section.buckets",
        fields: [
          { kind: "select", key: "bucketMode", label: "CVD Source", labelKey: "indicator.cvd.bucketMode", description: "Groups CVD by trade-notional size. Buckets 1–10 cover <1k, 1k–10k, 10k–25k, 25k–50k, 50k–100k, 100k–250k, 250k–500k, 500k–1m, 1m–5m, and 5m+ USD. If size data is unavailable, total delta is used.", descriptionKey: "indicator.cvd.bucketMode.description", options: [{ label: "Total Delta", value: "total", labelKey: "indicator.cvd.bucketMode.total" }, { label: "Retail / Mid / Whale", value: "preset", labelKey: "indicator.cvd.bucketMode.preset" }, { label: "Custom Buckets", value: "custom", labelKey: "indicator.cvd.bucketMode.custom" }], requiresRecalc: true },
          { kind: "text", key: "customBuckets", label: "Custom Buckets (1-10)", labelKey: "indicator.cvd.customBuckets", description: "Enter bucket numbers 1–10 separated by commas or spaces.", descriptionKey: "indicator.cvd.customBuckets.description", visibleWhen: { key: "bucketMode", values: ["custom"] }, requiresRecalc: true },
        ],
      },
      {
        title: "Appearance",
        titleKey: "indicator.common.section.appearance",
        fields: [
          { kind: "select", key: "plotStyle", label: "Plot Style", labelKey: "indicator.common.plotStyle", options: [{ label: "Line", value: "line", labelKey: "indicator.common.plotStyle.line" }, { label: "Histogram", value: "histogram", labelKey: "indicator.common.plotStyle.histogram" }, { label: "Area", value: "area", labelKey: "indicator.common.plotStyle.area" }] },
          { kind: "color", key: "lineColor", label: "Total/Custom Color", labelKey: "indicator.cvd.lineColor" },
          { kind: "color", key: "retailColor", label: "Retail Color", labelKey: "indicator.cvd.retailColor" },
          { kind: "color", key: "midColor", label: "Mid Color", labelKey: "indicator.cvd.midColor" },
          { kind: "color", key: "whaleColor", label: "Whale Color", labelKey: "indicator.cvd.whaleColor" },
          ...standardAppearanceFields(),
        ],
      },
    ],
  },
  getHeaderLabel: simpleHeader("CVD"),
  prepareCache: "series-range", prepareData: prepareCvdData,
  drawSubPane: drawMultiSeries,
};
