export type GpuBackendPreference = "auto" | "webgpu" | "webgl2" | "canvas2d";
export type WebGpuRolloutMode = "off" | "canary" | "auto";

export function isWebGpuSupported(): boolean {
  return typeof navigator !== "undefined" && Boolean((navigator as any).gpu);
}

export interface GpuSettings {
  readonly backend: GpuBackendPreference;
  readonly residentHeatmap: boolean;
  readonly asyncCapture: boolean;
  readonly nativeWebGpu?: boolean;
  readonly nativeWebGpuText?: boolean;
  readonly webgpuRollout?: WebGpuRolloutMode;
  readonly webgpuKillSwitch?: boolean;
}

export interface GpuSettingsSource {
  read(): GpuSettings;
  onChange(listener: () => void): () => void;
}

export const DEFAULT_GPU_SETTINGS: GpuSettings = Object.freeze({
  backend: "webgl2",
  residentHeatmap: false,
  asyncCapture: false,
  nativeWebGpu: true,
  nativeWebGpuText: true,
});

let configuredSource: GpuSettingsSource | null = null;
let sourceUnsubscribe: (() => void) | null = null;
const listeners = new Set<() => void>();
let cachedBaseSettings: GpuSettings | null = null;

function notifyListeners(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch (err) {
      console.error("[GpuSettings] listener failed", err);
    }
  }
}

export function configureGpuSettingsSource(source: GpuSettingsSource | null): void {
  if (sourceUnsubscribe) {
    sourceUnsubscribe();
    sourceUnsubscribe = null;
  }
  cachedBaseSettings = null;
  configuredSource = source;
  if (configuredSource) {
    sourceUnsubscribe = configuredSource.onChange(() => {
      cachedBaseSettings = null;
      notifyListeners();
    });
  }
  notifyListeners();
}

function parseUrlGpuParam(search?: string): GpuBackendPreference | null {
  if (!search) return null;
  const match = /[?&]gpu=([a-z0-9_-]+)/i.exec(search);
  if (!match) return null;
  const val = match[1].toLowerCase();
  if (val === "auto" || val === "webgpu" || val === "webgl2" || val === "canvas2d") {
    return val;
  }
  return null;
}

function parseUrlBoolParam(search: string | undefined, names: readonly string[]): boolean | null {
  if (!search) return null;
  for (const name of names) {
    const match = new RegExp(`[?&]${name}=([a-z0-9_-]+)`, "i").exec(search);
    if (!match) continue;
    const val = match[1].toLowerCase();
    if (val === "1" || val === "true") return true;
    if (val === "0" || val === "false") return false;
  }
  return null;
}

function parseUrlWebGpuRolloutParam(search?: string): WebGpuRolloutMode | null {
  if (!search) return null;
  const match = /[?&]webgpuRollout=([a-z0-9_-]+)/i.exec(search);
  if (!match) return null;
  const val = match[1].toLowerCase();
  if (val === "off" || val === "canary" || val === "auto") {
    return val;
  }
  return null;
}

export function readGpuSettings(win?: { location?: { search?: string } } | null): GpuSettings {
  if (!cachedBaseSettings) {
    cachedBaseSettings = configuredSource ? configuredSource.read() : DEFAULT_GPU_SETTINGS;
  }
  const base = cachedBaseSettings;

  let search: string | undefined;
  if (win && win.location && typeof win.location.search === "string") {
    search = win.location.search;
  } else if (typeof window !== "undefined" && window.location && typeof window.location.search === "string") {
    search = window.location.search;
  }

  const override = parseUrlGpuParam(search);
  const nativeOverride = parseUrlBoolParam(search, ["webgpuNative", "gpuNative"]);
  const nativeTextOverride = parseUrlBoolParam(search, ["webgpuText", "gpuText"]);
  const residentHeatmapOverride = parseUrlBoolParam(search, ["residentHeatmap", "heatmapGpu"]);
  const rolloutOverride = parseUrlWebGpuRolloutParam(search);
  const killSwitchOverride = parseUrlBoolParam(search, ["webgpuKillSwitch"]);
  if (
    override ||
    nativeOverride !== null ||
    nativeTextOverride !== null ||
    residentHeatmapOverride !== null ||
    rolloutOverride !== null ||
    killSwitchOverride !== null
  ) {
    return {
      ...base,
      ...(override ? { backend: override } : {}),
      ...(nativeOverride !== null ? { nativeWebGpu: nativeOverride } : {}),
      ...(nativeTextOverride !== null ? { nativeWebGpuText: nativeTextOverride } : {}),
      ...(residentHeatmapOverride !== null ? { residentHeatmap: residentHeatmapOverride } : {}),
      ...(rolloutOverride !== null ? { webgpuRollout: rolloutOverride } : {}),
      ...(killSwitchOverride !== null ? { webgpuKillSwitch: killSwitchOverride } : {}),
    };
  }

  return base;
}

export function onGpuSettingsChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function resetGpuSettingsForTest(): void {
  if (sourceUnsubscribe) {
    sourceUnsubscribe();
    sourceUnsubscribe = null;
  }
  cachedBaseSettings = null;
  configuredSource = null;
  listeners.clear();
}
