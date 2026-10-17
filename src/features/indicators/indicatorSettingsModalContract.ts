import type { IndicatorSettings, IndicatorSettingsSchema } from "./types.js";

/** Internal owner-document events used by the indicator settings overlay. */
export const INDICATOR_SETTINGS_MODAL_REQUEST_EVENT = "indicator-settings-modal-request";
export const INDICATOR_SETTINGS_MODAL_DISMISS_EVENT = "indicator-settings-modal-dismiss";

export type IndicatorSettingsModalCloseReason =
  | "close-button"
  | "save"
  | "escape"
  | "scrim"
  | "replaced"
  | "dispose";

export interface IndicatorSettingsModalCommands {
  /** Valid previews only; transient/invalid number input must not be emitted. */
  preview(settings: IndicatorSettings): void;
  /** Save applies the final draft before close; close/Escape/scrim do not rollback. */
  save(settings: IndicatorSettings): void;
  close(reason: IndicatorSettingsModalCloseReason): void;
}

export interface IndicatorSettingsModalRequestDetail {
  instanceId: string;
  title: string;
  schema: IndicatorSettingsSchema;
  initialSettings: IndicatorSettings;
  trigger: HTMLElement | null;
  /** Restores focus even when a header re-render detached the original trigger. */
  restoreFocus: () => void;
  /** Manager-owned token; stale/disposed callbacks must be ignored. */
  token: number;
  commands: IndicatorSettingsModalCommands;
}

export interface IndicatorSettingsModalDismissDetail {
  instanceId: string;
  token: number;
  reason: IndicatorSettingsModalCloseReason;
}
