/**
 * Unified canvas target abstraction for DOM (`HTMLCanvasElement`) and Worker
 * (`OffscreenCanvas`) rendering surfaces.
 *
 * Strictly DOM-free at module load time so plain Node tests and DedicatedWorkers
 * can import it without `window` or `document`.
 */

export type CanvasTarget = HTMLCanvasElement | OffscreenCanvas;
export type Canvas2dContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export function isOffscreenCanvas(canvas: CanvasTarget | null | undefined): canvas is OffscreenCanvas {
  if (!canvas) return false;
  if (typeof OffscreenCanvas !== "undefined" && canvas instanceof OffscreenCanvas) {
    return true;
  }
  return !("ownerDocument" in canvas) && typeof (canvas as OffscreenCanvas).convertToBlob === "function";
}

export function getCanvasOwnerDocument(canvas: CanvasTarget | null | undefined): Document | null {
  if (!canvas) return null;
  if ("ownerDocument" in canvas) {
    return canvas.ownerDocument ?? null;
  }
  return null;
}

export function createScratchCanvas(
  width: number,
  height: number,
  ownerDocument?: Document | null,
): CanvasTarget | null {
  const safeW = Math.max(1, Math.floor(width) || 1);
  const safeH = Math.max(1, Math.floor(height) || 1);

  if (ownerDocument && typeof ownerDocument.createElement === "function") {
    const canvas = ownerDocument.createElement("canvas");
    canvas.width = safeW;
    canvas.height = safeH;
    return canvas;
  }

  if (typeof OffscreenCanvas === "function") {
    return new OffscreenCanvas(safeW, safeH);
  }

  if (typeof document !== "undefined" && typeof document.createElement === "function") {
    const canvas = document.createElement("canvas");
    canvas.width = safeW;
    canvas.height = safeH;
    return canvas;
  }

  return null;
}

export function getScratch2dContext(canvas: CanvasTarget | null | undefined): Canvas2dContext | null {
  if (!canvas || typeof canvas.getContext !== "function") return null;
  return (canvas.getContext("2d") as Canvas2dContext | null) ?? null;
}
