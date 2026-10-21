// Series/heatmap color constants — core layer so both `features/*` and
// `platform/*` can import them without violating the layer gate
// (features -> platform is an upward import and is disallowed by
// scripts/depgraph.mjs). `src/platform/ui/theme.ts` re-exports these for
// platform-layer consumers that already import `theme`.
//
// Values are preserved byte-for-byte from the pre-Faz-5 sources:
// - `seriesPalette`: IndicatorManager.ts's local `colors` array (default
//   line/series color cycle for user-configurable indicator lines).
// - `heatmap`: the app's features/options/visualize.ts's DIVERGENT_STOPS/INTENSITY_STOPS
//   (shared put/call divergent scale + single-hue intensity scale).
// User-saved indicator settings / layout JSON reference these by value, so
// they must not change.

export const seriesPalette = [
  "#7dd3fc",
  "#f59e0b",
  "#a78bfa",
  "#34d399",
  "#fb7185",
  "#facc15",
  "#c084fc",
  "#22d3ee",
] as const;

// Fallback default for a generic indicator "color" settings field (distinct
// from the seriesPalette cycle — used when no seed color is stored yet).
export const indicatorColorDefault = "#3b82f6";

// Fallback default for VWAP band color (settings field + line-list rows).
export const vwapBandColorDefault = "#93c5fd";

// Per-indicator single-series default "color" settings field fallbacks.
// Each value is preserved byte-for-byte from the indicator builtin that
// previously hardcoded it — these are the user-visible default line/histogram
// colors shown before a user picks their own, so the value itself must not
// drift (only its source moves to this shared, checkui-exempt module).
export const atrColorDefault = "#f97316";
export const cciColorDefault = "#e879f9";
export const mfiColorDefault = "#2dd4bf";
export const tradeCountColorDefault = "#c084fc";
export const deltaColorDefault = "#60a5fa";
export const vwapIndicatorLineColorDefault = "#66bb6a";
export const bollingerBasisColorDefault = "#f8fafc";
export const macdHistogramColorDefault = "#64748b";
export const volumeProfileReadoutTextColor = "rgba(226,232,240,0.88)";
export const taSharedLevelLabelColor = "rgba(255,255,255,0.5)";
export const barStatsTextColorDefault = "#e2e8f0";
export const barStatsLabelColor = "rgba(148,163,184,0.92)";

// Shared "no-data" warning message color for derivative-metrics indicator
// panes (cross-exchange OI, funding regime, liquidations, futures
// positioning) — a role distinct from the canonical `warn` accent (used for
// user-facing settings/status chrome), so kept as its own preserved default.
export const indicatorWarningMessageColor = "#ffb86b";
export const openInterestLineColorDefault = "#7dd3fc";
export const fundingPredictedColorDefault = "#f2c94c";
export const positioningRatioColorDefault = "#8ab4ff";
export const gexFlipColorDefault = "#b86aff";
export const gexMaxPainColorDefault = "#f2c94c";
export const gexWallTagTextColor = "#071016";

// Price/time axis chrome — faint gridlines and label chrome distinct enough
// from the semantic bg/border/text tokens above (they're deliberately
// lighter/fainter to stay subordinate to plot content) to keep as their own
// preserved defaults rather than force onto the nearest token and drift the
// look of the axis.
export const axisGridLineColor = "rgba(255,255,255,0.05)";
export const axisMajorLabelColor = "#c9d2e0";
export const axisLabelBorderColor = "rgba(148, 163, 184, 0.24)";
export const axisMajorTickColor = "rgba(255,255,255,0.2)";
export const timeAxisCrosshairLabelBg = "rgba(15, 22, 34, 0.94)";
export const indicatorPaneBackgroundColor = "#0b0d12";
export const indicatorBadgeBg = "rgba(15, 22, 34, 0.88)";
export const indicatorBadgeBorder = "rgba(148, 163, 184, 0.22)";
export const indicatorReadoutTextColor = "#f2f5fb";
export const indicatorMessageTextColor = "#aeb7c7";
export const indicatorLastValueTextColor = "#07111f";
export const indicatorAxisTickTextColor = "rgba(216,224,238,0.74)";
export const indicatorHoverGuideColor = "rgba(255,255,255,0.35)";

// Drawing tool DEFAULT colors (features/drawings/toolRegistry.ts,
// drawingManager.ts). These only seed NEW drawings — a saved drawing stores
// its color by value in the workspace JSON, so moving these constants here
// changes nothing for existing user drawings. Values preserved byte-for-byte;
// where a value already equals a canonical token (#e6c84f=warn, #3fe0a0=buy)
// the call site uses the token directly.
export const drawingShapeColorDefault = "#4a90d9"; // rectangle/ellipse/triangle
export const drawingChannelColorDefault = "#64b5f6"; // session-box/date-marker/parallel-channel/gann-grid
export const drawingFibColorDefault = "#f6c85f"; // fib/pitchfork/gann-fan/liquidity-zone
export const drawingAccentColorDefault = "#d98de7"; // imbalance-zone/event-marker
export const drawingMeasureColorDefault = "#7dd3fc"; // measure/price-range/date-range (= seriesPalette[0])
export const drawingShortColorDefault = "#ef5350"; // short-position
export const drawingRegressionColorDefault = "#9fb7ff"; // regression-channel

// Categorical data-viz palettes (documented exceptions — multi-category
// series identity colors, NOT buy/sell/warn/info roles; values preserved
// byte-for-byte):
// TPO / Market Profile block palette (core/render/overlay.ts).
export const tpoPalette = {
  latest: "#d8484f", // current price bin marker (MMT-style red)
  poc: "#e8edf4", // POC row (near-white)
  pocLetters: "#e6c84f", // POC letter in letters mode (= warn value)
  valueArea: "#3b6fd6", // rows inside the value area
  outside: "#5a6573", // rows outside the value area
  letters: "#9fb4cc", // plain letters
  leaderPoc: "#ffffff", // POC leader line + label
  leaderVa: "#7aa8e0", // VAH/VAL leader lines + labels
} as const;
// Footprint cell "weak signal" dimmed tones — deliberately muted second tier
// next to canonical buy/sell (core/render/overlay.ts cell text).
export const cellDimSell = "#c9777c";
export const cellDimBuy = "#6fae93";
// Naked POC per-period palette (core/render/overlay.ts; mirrored by
// ObjectTreePanel legend) — daily/weekly/monthly/quarterly/half-yearly/yearly.
export const nakedPocPalette = {
  daily: "#f6c85f",
  weekly: "#d98de7",
  monthly: "#64b5f6",
  quarterly: "#4dd0e1",
  halfYearly: "#26a69a",
  yearly: "#ef5350",
} as const;
// Reference-level family gradients (core/analysis/referenceLevels.ts) —
// ColorBrewer-like per-period ramps for eq/open/level/valueArea families.
export const referenceLevelPalette = {
  eq: ["#66c2a5", "#41ae76", "#238b45", "#006d2c", "#005a26", "#00441b"],
  open: ["#fdd0a2", "#fdae6b", "#fd8d3c", "#f16913", "#d94801", "#8c2d04"],
  level: ["#9ecae1", "#6baed6", "#4292c6", "#2171b5", "#08519c", "#08306b"],
  valueArea: ["#dadaeb", "#bcbddc", "#9e9ac8", "#807dba", "#6a51a3", "#4a1486"],
} as const;
// Strategy-level tier tones (core/analysis mondayRange/previousWeekStrategy) —
// lighter second-tier extension / golden-zone tones alongside canonical warn.
export const strategyExtSoftColor = "#fbbf24";
export const strategyGoldenColor = "#eab308";
// drawingManager.ts chrome: callout/label text and label pill.
export const drawingLabelTextColor = "#dbe3f4";
export const drawingLabelPillBg = "rgba(13, 17, 26, 0.82)";
export const drawingLabelPillBorder = "rgba(255, 255, 255, 0.10)";
export const drawingAnchorPrimaryFill = "#ffffff";
export const drawingAnchorOutline = "#111722";
// overlay.ts chrome: line-label pill backdrop, crosshair lines.
export const lineLabelPillBg = "rgba(11, 16, 24, 0.88)";
export const crosshairLineColor = "rgba(255,255,255,0.25)";
export const syncCrosshairLineColor = "rgba(150,170,200,0.35)";

// LEGACY MIGRATION SNAPSHOTS (platform/workspace/migration.ts) — these hex
// strings are written INTO migrated user settings and are part of the
// deterministic "same input → same output" migration contract. They are
// frozen historical values, NOT living design tokens: NEVER retune them to
// match the current palette. (Moving them here only centralizes the source;
// byte-identical values keep migration output unchanged.)
export const legacyMovingAverageMigrationColors = {
  "ma-daily-50": "#7dd3fc",
  "ma-daily-100": "#38bdf8",
  "ma-daily-200": "#0284c7",
  "ma-weekly-50": "#c4b5fd",
  "ma-weekly-100": "#a78bfa",
  "ma-weekly-200": "#7c3aed",
} as const;
export const legacyVwapMigrationColors = {
  "rolling-24h": "#4fc3f7",
  "rolling-7d": "#29b6f6",
  "rolling-30d": "#039be5",
  "rolling-90d": "#0288d1",
  "rolling-365d": "#0277bd",
  "current-daily": "#66bb6a",
  "current-weekly": "#43a047",
  "current-monthly": "#7cb342",
  "current-quarterly": "#c0ca33",
  "current-half-yearly": "#f9a825",
  "current-yearly": "#fb8c00",
  "previous-weekly": "#ab47bc",
  "previous-monthly": "#8e24aa",
  "previous-quarterly": "#7e57c2",
  "previous-half-yearly": "#5e35b1",
  "previous-yearly": "#3949ab",
} as const;

// Semantic canvas/render color tokens — core-layer mirror of the relevant
// subset of `src/platform/ui/theme.ts`'s `theme.color`. Values MUST stay
// byte-identical to theme.ts (enforced by
// tests/seriesPaletteTokenParity.test.mjs). This exists so core/features
// render code (canvas overlays, indicator builtins, drawing tools) can reach
// the canonical buy/sell/warn/info palette without an upward
// features/core -> platform import, which scripts/depgraph.mjs forbids.
export const uiColor = {
  buy: "#3fe0a0",
  sell: "#e06c75",
  warn: "#e6c84f",
  info: "#38bdf8",
  special: "#a78bfa",

  buyFill: "rgba(63,224,160,0.34)",
  sellFill: "rgba(224,108,117,0.34)",
  buyFillSoft: "rgba(63,224,160,0.10)",
  sellFillSoft: "rgba(224,108,117,0.10)",

  text: "#c8cdd6",
  textSecondary: "#8a93a6",
  textMuted: "#687386",
  textHeading: "#eef2fb",

  bgApp: "#0d0f14",
  bgShade: "#080a0f",
  bgPanel: "#151922",
  bgPanelAlt: "#1c2230",
  bgSurface: "#222835",
  bgHover: "#242b38",
  bgActive: "#2b3342",

  border: "#2c3444",
  borderStrong: "#303849",
  separator: "rgba(255,255,255,0.08)",
  separatorStrong: "rgba(255,255,255,0.12)",
} as const;

export const heatmap = {
  divergent: [
    { stop: -1, rgb: [245, 130, 10] }, // strong put #F5820A
    { stop: -0.5, rgb: [110, 74, 46] }, // weak put (brown)
    { stop: 0, rgb: [17, 17, 17] }, // neutral #111
    { stop: 0.5, rgb: [30, 58, 110] }, // weak call (navy)
    { stop: 1, rgb: [30, 155, 255] }, // strong call #1E9BFF
  ],
  intensity: [
    { stop: 0, rgb: [17, 17, 17] },
    { stop: 1, rgb: [30, 155, 255] },
  ],
} as const;
