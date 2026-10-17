/** Bir veri parçasının kaynağı + kalitesi. `scripts/bridge/meta.mjs` üreticisinin tip karşılığı. */
export interface DataProvenance {
  source: string; // "binance-klines" | "footprint-cache" | "aggr" | "coinalyze" ...
  market?: string;
  completeness?: "complete" | "partial" | "provisional";
  from?: number;
  to?: number;
  /** Kaynak fetch hatası oluştuysa hata mesajı (degraded veri sinyali). */
  error?: string;
}

/**
 * Tipli envelope meta. `meta.schemaVersion` wire shape değişince artar (drift sinyali).
 * Tüm alanlar opsiyonel/eklemelidir; bu modül bu sözleşmenin TEK kaynağıdır
 * (üretici: `scripts/bridge/meta.mjs`).
 */
/** Bridge maintenance endpoint'lerinin durum sözleşmesi (panel kontratları da tüketir). */
export interface MaintenanceStatus {
  cacheBytes: number;
  dataBytes: number;
  policy: Record<string, number>;
}

export interface MaintenanceCleanupResult extends MaintenanceStatus {
  removedFiles: number;
  freedBytes: number;
  dryRun: boolean;
  cacheCandidateFiles?: number;
  cacheCandidateBytes?: number;
  cacheOldestMs?: number | null;
  dataCandidateFiles?: number;
  dataCandidateBytes?: number;
  dataOldestMs?: number | null;
}

export interface FootprintCoverage {
  schemaVersion: 1;
  source: string;
  instrument: string;
  authority: "canonical" | "provisional" | "mixed" | null;
  status: "verified" | "complete" | "pending" | "gap" | "degraded" | "error";
  requestedFrom: number;
  requestedTo: number;
  coveredFrom: number | null;
  coveredThrough: number | null;
  durableThroughId: string | null;
  projectionThroughId: string | null;
  authorityToken: string | null;
  reasonCode: string | null;
}

export interface LegacyTradeIdRepairCoverageProof {
  kind: "resolver-contiguous-v1";
  authority: "provisional" | "mixed";
  requestedFrom: number;
  requestedTo: number;
  coveredFrom: number;
  coveredThrough: number;
  complete: boolean;
}

export interface TradeIdRepairCoverageProof {
  kind: "resolver-watermark-contiguous-v2";
  authority: "provisional" | "mixed";
  authorityToken: string;
  projectionThroughId: string;
  requestedFrom: number;
  requestedTo: number;
  coveredFrom: number;
  coveredThrough: number;
  watermarkComplete: boolean;
}

export type TradeIdRepairPrefixProof =
  | {
      kind: "event-time-prefix-v1";
      requestedFrom: number;
      firstEventTime: number;
    }
  | {
      /** Legacy wire kind: verified generation proves the prefix; IDs need only advance. */
      kind: "adjacent-agg-id-prefix-v1";
      requestedFrom: number;
      firstEventTime: number;
      previousProjectionId: string;
      firstAggregateId: string;
    }
  | {
      /** Verified REST discovery proves the empty prefix without fabricating event time. */
      kind: "rest-discovery-prefix-v1";
      requestedFrom: number;
      firstEventTime: number;
      firstAggregateId: string;
      discoveryFrom: number;
      discoveryAt: number;
      visionCoverageEnd: number | null;
    };

export interface PrefixTradeIdRepairCoverageProof {
  kind: "resolver-watermark-prefix-v3";
  authority: "provisional" | "mixed";
  authorityToken: string;
  projectionThroughId: string;
  requestedFrom: number;
  requestedTo: number;
  coveredFrom: number;
  coveredThrough: number;
  watermarkComplete: true;
  prefixProof: TradeIdRepairPrefixProof;
}

interface TradeIdRepairSnapshotBase {
  mode: "trade-id-v1";
  source: "binance-usdm-aggTrade" | (string & {});
  instrument: string;
  interval: number;
  priceStep: number;
  authority: "provisional" | "mixed";
  authorityToken: string;
  watermark: string;
  requestedFrom: number;
  requestedTo: number;
  coveredFrom: number;
  coveredThrough: number;
  bucketFrom: number;
  bucketThrough: number;
}

/** Legacy snapshots remain accepted only under their original full event-time coverage rule. */
export interface LegacyTradeIdRepairSnapshot extends TradeIdRepairSnapshotBase {
  schemaVersion: 1;
  coverageProof?: LegacyTradeIdRepairCoverageProof;
}

/**
 * Legacy watermark snapshot. It remains accepted only when event-time coverage itself
 * reaches the requested prefix; new producers use schemaVersion 3 so an empty prefix can
 * be proven explicitly instead of moving real event timestamps.
 */
export interface WatermarkTradeIdRepairSnapshot extends TradeIdRepairSnapshotBase {
  schemaVersion: 2;
  coverageProof: TradeIdRepairCoverageProof;
}

/**
 * Current reconnect-repair contract. `prefixProof` says why the requested prefix is known
 * complete. `event-time-prefix-v1` is the ordinary coveredFrom<=requestedFrom case;
 * the legacy-named `adjacent-agg-id-prefix-v1` proves an empty UTC-day prefix from a
 * verified generation snapshot. `rest-discovery-prefix-v1` proves the equivalent prefix
 * from the persisted REST discovery boundary even when no previous provisional day exists.
 * Aggregate IDs are monotonic cursors, not a gap-free transport sequence, so neither proof
 * changes transport-sequence semantics.
 */
export interface PrefixTradeIdRepairSnapshot extends TradeIdRepairSnapshotBase {
  schemaVersion: 3;
  coverageProof: PrefixTradeIdRepairCoverageProof;
}

export type TradeIdRepairSnapshot =
  | LegacyTradeIdRepairSnapshot
  | WatermarkTradeIdRepairSnapshot
  | PrefixTradeIdRepairSnapshot;

export interface CandleCoverage {
  schemaVersion: 1;
  source: "binance-klines" | (string & {});
  instrument: string;
  ownership: "snapshot" | null;
  status: "verified" | "unknown" | "error";
  requestedFrom: number;
  requestedTo: number;
  snapshotAt: number | null;
  closedThrough: number | null;
  reasonCode: string | null;
}

export interface EnvelopeMeta {
  schemaVersion: number;
  generatedAt: number;
  cache?: { hit: boolean; key?: string; generatedAt?: number };
  provenance?: DataProvenance[];
  requestId?: string;
  footprintCoverage?: FootprintCoverage;
  repairSnapshot?: TradeIdRepairSnapshot;
  candleCoverage?: CandleCoverage;
  /** Yanıt kısmi/hatalı kaynaktan üretildiyse true (bkz. provenance[].error). */
  degraded?: boolean;
  /**
   * `/history`'nin footprint tarafı. `priceStep`, store'un GERÇEKTEN okunduğu adımdır:
   * store anahtarı adımı hash'lediği ve sunucu tarafı sentinel'i istemcinin gönderdiği
   * değere tercih ettiği için, istemcinin istediği adım sessizce ezilmiş olabilir.
   * `available` false ise footprint sorgusu başarısız oldu (mumlar yine de geldi).
   * `lastPublishedDay`, Vision arşivi yayımlanmış en yeni UTC günüdür; istemci
   * on-demand doldurmayı yayın gecikmesini kendi hesaplamadan buna göre sınırlar.
   */
  footprint?: {
    priceStep?: number;
    available?: boolean;
    lastPublishedDay?: number;
    /** Bu markette footprint toplanıyor mu (allowlist). */
    allowed?: boolean;
    /**
     * Okunmuş ama yanıta girmemiş footprint bar sayısı: kova için mum yoksa hücreler
     * yayınlanmaz. 0'dan büyükse yanıt, elinde olan hücrelerin bir kısmını taşımıyor.
     */
    droppedBars?: number;
  };
}
