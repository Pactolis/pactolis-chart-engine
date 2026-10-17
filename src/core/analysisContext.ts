import type { VolumeProfileSettings } from "./analysis/volumeProfile.js";
import type { PreviousWeekStrategyLevel, PreviousWeekStrategySettings } from "./analysis/previousWeekStrategy.js";
import type { MondayRangeLevel, MondayRangeSettings } from "./analysis/mondayRange.js";
import type { NakedPocLevel } from "./analysis/nakedPoc.js";
import type { ReferenceLevel } from "./analysis/referenceLevels.js";
import type { DrawingManager } from "../features/drawings/drawingManager.js";

export interface AnalysisContext {
  /** Market whose automatic levels are represented by this context. */
  market: string;
  profileSettings: VolumeProfileSettings;
  previousWeekStrategySettings: PreviousWeekStrategySettings;
  previousWeekStrategyLevels: PreviousWeekStrategyLevel[];
  mondayRangeSettings: MondayRangeSettings;
  mondayRangeLevels: MondayRangeLevel[];
  nakedPocs: NakedPocLevel[];
  referenceLevels: ReferenceLevel[];
  drawings: DrawingManager;
}

/** Automatic levels a replaying chart may show as of its replay time; nPOC and backend value areas are excluded. */
export type AutomaticLevelsAsOf = Pick<AnalysisContext, "previousWeekStrategyLevels" | "mondayRangeLevels" | "referenceLevels">;
