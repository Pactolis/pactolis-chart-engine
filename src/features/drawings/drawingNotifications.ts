/** Owns host callbacks and the persisted/transient notification boundary. Depends only on the state capabilities declared below; it never selects or edits drawings. The state owner supplies those capabilities; outward callbacks retain their original order. */
import type { Drawing, DrawingType } from "../../core/drawingTypes.js";

export abstract class DrawingNotifications {
  protected abstract drawings: Drawing[];
  protected abstract draft: Drawing | null;
  protected abstract displayNameCache: Map<string, string> | null;
  protected abstract summaryRevision: number;


  constructor(
    private readonly onChange: (drawings: Drawing[], transient: boolean) => void,
    private readonly onToolChange?: (tool: DrawingType | null) => void,
    private readonly onRequestText?: (id: string, deleteOnCancel?: boolean) => void,
    private readonly onRequestSettings?: (id: string) => void,
  ) {}

  private changed(transient = false): void {
    this.displayNameCache = null;
    this.summaryRevision++;
    this.onChange(structuredClone(this.drawings.filter((drawing) => drawing.id !== this.draft?.id)), transient);
  }
}
