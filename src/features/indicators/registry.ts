import type { IndicatorDefinition, IndicatorInstance, IndicatorPlacement, IndicatorSettings } from "./types.js";
import { atrIndicatorDefinition } from "./builtins/atr.js";
import { barStatsIndicatorDefinition } from "./builtins/barStats.js";
import { bollingerIndicatorDefinition } from "./builtins/bollinger.js";
import { cciIndicatorDefinition } from "./builtins/cci.js";
import { cvdIndicatorDefinition } from "./builtins/cvd.js";
import { deltaIndicatorDefinition } from "./builtins/delta.js";
import { dmiIndicatorDefinition } from "./builtins/dmi.js";
import { ichimokuIndicatorDefinition } from "./builtins/ichimoku.js";
import { kdjIndicatorDefinition } from "./builtins/kdj.js";
import { macdIndicatorDefinition } from "./builtins/macd.js";
import { mfiIndicatorDefinition } from "./builtins/mfi.js";
import { movingAverageIndicatorDefinition } from "./builtins/movingAverage.js";
import { rsiIndicatorDefinition } from "./builtins/rsi.js";
import { stochRsiIndicatorDefinition } from "./builtins/stochRsi.js";
import { superTrendIndicatorDefinition } from "./builtins/superTrend.js";
import { tradeCountIndicatorDefinition } from "./builtins/tradeCount.js";
import { volumeIndicatorDefinition } from "./builtins/volume.js";
import { volumeProfileIndicatorDefinition } from "./builtins/volumeProfile.js";
import { vwapIndicatorDefinition } from "./builtins/vwapIndicator.js";

const staticDefinitions = [
  movingAverageIndicatorDefinition,
  bollingerIndicatorDefinition,
  superTrendIndicatorDefinition,
  vwapIndicatorDefinition,
  rsiIndicatorDefinition,
  stochRsiIndicatorDefinition,
  macdIndicatorDefinition,
  kdjIndicatorDefinition,
  cciIndicatorDefinition,
  dmiIndicatorDefinition,
  atrIndicatorDefinition,
  mfiIndicatorDefinition,
  volumeIndicatorDefinition,
  volumeProfileIndicatorDefinition,
  barStatsIndicatorDefinition,
  deltaIndicatorDefinition,
  tradeCountIndicatorDefinition,
  ichimokuIndicatorDefinition,
  cvdIndicatorDefinition,
] as const;

export interface IndicatorCatalogEntry {
  type: string;
  name: string;
  category: IndicatorDefinition["category"];
  defaultPane: IndicatorDefinition["defaultPane"];
}

type HeavyIndicatorType =
  | "cross-exchange-open-interest"
  | "funding-regime"
  | "futures-positioning"
  | "liquidations"
  | "options-gex-wall";

const heavyCatalog: Record<HeavyIndicatorType, IndicatorCatalogEntry> = {
  "cross-exchange-open-interest": { type: "cross-exchange-open-interest", name: "Cross-Exchange OI", category: "derivatives", defaultPane: "separate" },
  "funding-regime": { type: "funding-regime", name: "Funding Regime", category: "derivatives", defaultPane: "separate" },
  "futures-positioning": { type: "futures-positioning", name: "Futures Positioning", category: "derivatives", defaultPane: "separate" },
  liquidations: { type: "liquidations", name: "Liquidations", category: "derivatives", defaultPane: "separate" },
  "options-gex-wall": { type: "options-gex-wall", name: "Options GEX Wall", category: "derivatives", defaultPane: "overlay" },
};

const heavyLoaders: Record<HeavyIndicatorType, () => Promise<IndicatorDefinition>> = {
  "cross-exchange-open-interest": () => import("./builtins/crossExchangeOpenInterest.js").then((module) => module.crossExchangeOpenInterestIndicatorDefinition as IndicatorDefinition),
  "funding-regime": () => import("./builtins/fundingRegime.js").then((module) => module.fundingRegimeIndicatorDefinition as IndicatorDefinition),
  "futures-positioning": () => import("./builtins/futuresPositioning.js").then((module) => module.futuresPositioningIndicatorDefinition as IndicatorDefinition),
  liquidations: () => import("./builtins/liquidations.js").then((module) => module.liquidationsIndicatorDefinition as IndicatorDefinition),
  "options-gex-wall": () => import("./builtins/optionsGexWall.js").then((module) => module.optionsGexWallIndicatorDefinition as IndicatorDefinition),
};

export const indicatorRegistry: Record<string, IndicatorDefinition> = Object.fromEntries(
  staticDefinitions.map((definition) => [definition.type, definition as IndicatorDefinition]),
);
const loadingDefinitions = new Map<string, Promise<IndicatorDefinition>>();

function isHeavyType(type: string): type is HeavyIndicatorType {
  return Object.prototype.hasOwnProperty.call(heavyLoaders, type);
}

export function listIndicatorDefinitions(): IndicatorCatalogEntry[] {
  return [
    ...staticDefinitions.map((definition) => ({
      type: definition.type,
      name: definition.name,
      category: definition.category,
      defaultPane: definition.defaultPane,
    })),
    ...Object.values(heavyCatalog),
  ];
}

export function getIndicatorDefinition(type: string): IndicatorDefinition | undefined {
  return indicatorRegistry[type];
}

export async function preloadIndicatorDefinition(type: string): Promise<IndicatorDefinition | undefined> {
  const current = indicatorRegistry[type];
  if (current) return current;
  if (!isHeavyType(type)) return undefined;
  let pending = loadingDefinitions.get(type);
  if (!pending) {
    pending = heavyLoaders[type]().then((definition) => {
      indicatorRegistry[type] = definition;
      loadingDefinitions.delete(type);
      return definition;
    }).catch((error) => {
      loadingDefinitions.delete(type);
      throw error;
    });
    loadingDefinitions.set(type, pending);
  }
  return pending;
}

export async function preloadIndicatorDefinitions(types: Iterable<string>): Promise<void> {
  const unique = [...new Set(types)];
  await Promise.all(unique.map((type) => preloadIndicatorDefinition(type)));
}

export function defaultIndicatorPlacement(definition: IndicatorDefinition): IndicatorPlacement {
  return definition.defaultPlacement ?? (definition.defaultPane === "overlay" ? "price-overlay" : "separate-pane");
}

export function supportedIndicatorPlacements(definition: IndicatorDefinition): IndicatorPlacement[] {
  if (definition.supportedPlacements?.length) return definition.supportedPlacements;
  return definition.canOverlay ? ["separate-pane", "price-overlay", "overlay-scale"] : [defaultIndicatorPlacement(definition)];
}

export function isIndicatorPlacementSupported(definition: IndicatorDefinition, placement: unknown): placement is IndicatorPlacement {
  return typeof placement === "string" && supportedIndicatorPlacements(definition).includes(placement as IndicatorPlacement);
}

function randomId(): string {
  const cryptoObject = globalThis.crypto;
  if (cryptoObject && "randomUUID" in cryptoObject) return cryptoObject.randomUUID();
  return `ind_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function createIndicatorInstance(type: string, order: number): IndicatorInstance {
  const definition = getIndicatorDefinition(type);
  if (!definition) throw new Error(`Unknown or unloaded indicator type: ${type}`);
  const id = randomId();
  return {
    id,
    type: definition.type,
    title: definition.name,
    visible: true,
    paneId: `pane_${id}`,
    order,
    paneHeight: definition.paneHeight,
    collapsed: false,
    placement: defaultIndicatorPlacement(definition),
    settings: structuredClone(definition.defaultSettings()) as IndicatorSettings,
    style: {},
  };
}

export async function createIndicatorInstanceAsync(type: string, order: number): Promise<IndicatorInstance> {
  await preloadIndicatorDefinition(type);
  return createIndicatorInstance(type, order);
}
