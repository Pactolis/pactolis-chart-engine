type TransientMagnetListener = (active: boolean) => void;

const activeSources = new Set<object>();
const listeners = new Set<TransientMagnetListener>();

export function isDrawingMagnetTransientActive(
  activeTool: string | null,
  modifiers: Pick<MouseEvent, "ctrlKey" | "metaKey">,
): boolean {
  return activeTool !== null && (modifiers.ctrlKey || modifiers.metaKey);
}

export function setDrawingMagnetTransient(source: object, active: boolean): void {
  const wasActive = activeSources.has(source);
  if (active === wasActive) return;
  const wasWindowActive = activeSources.size > 0;

  if (active) activeSources.add(source);
  else activeSources.delete(source);

  const isActive = activeSources.size > 0;
  if (isActive === wasWindowActive) return;
  listeners.forEach((listener) => listener(isActive));
}

export function subscribeDrawingMagnetTransient(listener: TransientMagnetListener): () => void {
  listeners.add(listener);
  listener(activeSources.size > 0);
  return () => {
    listeners.delete(listener);
  };
}
