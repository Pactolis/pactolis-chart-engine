// TEST-ONLY opt-in bounded diagnosis. Never feature or physical GPU acceptance.
import { expect, test, type Page } from "@playwright/test";
import type { ChartCaptureReadiness } from "../../src/features/chart/captureReadiness.js";
import type { View } from "../../src/core/engine/view.js";
import type { FootprintSeries } from "../../src/core/model/footprint.js";
import type { ChartPanelState } from "../../src/core/chartPanelState.js";
import { buildBars, FROZEN_NOW, FUNCTIONAL_WEBGL_ARGS, openHarness } from "./support/history.js";

test.use({ launchOptions: { args: [...FUNCTIONAL_WEBGL_ARGS] } });

type RuntimeProbe = {
heatmapTexturePrototypeEnabled?: boolean;
view: View;
pipeline: { series: FootprintSeries };
getState(): ChartPanelState;
updateState(state: ChartPanelState): void;
getCaptureReadiness(): ChartCaptureReadiness;
subscribeCaptureReadiness(cb: (snapshot: ChartCaptureReadiness) => void): () => void;
setVisibleTimeRange(range: { from: number; to: number }): void;
invalidate(): void;
orderbookHeatmap: {
bars: Map<number, { t: number; cells: number[][] }>;
chunks: Map<number, { status: string }>;
inFlight: Set<AbortController>;
};
session: {
gl: WebGL2RenderingContext;
pendingCapture: unknown;
captureCompositePng(): Promise<{ blob: Blob; width: number; height: number }>;
};
};
type Frame = {
enabled: boolean; reads: number; preserve: boolean | undefined;
gpu: number[][]; annotation: number[][]; composite: number[][]; nativeOracle: number[][];
candle: number[]; axes: number[]; geometry: number[];
observation: Record<string, any>;
};
const hookSelector = '[data-testid="chart-hook"]:not([data-ft-synthetic="1"])';

async function prepare(page: Page, empty: boolean): Promise<string> {
await page.setViewportSize({ width: 1800, height: 1000 });

const bars = buildBars(500).map((bar) => ({
...bar, o: 250, h: 350, l: 50, c: 260, v: 4, d: 0, n: 4,

cells: [[50, 0, 1, 0, 0, 1, 0, 1], [250, 1, 1, 0, 0, 2, 1, 1], [350, 1, 0, 0, 0, 1, 1, 0]], lb: 0, ls: 0,
}));
await page.route(/\/history(?:\?.*)?$/, (route) => route.fulfill({
contentType: "application/json", body: JSON.stringify({ ok: true, data: { bars } }),
}));
let acknowledgements = 0;
await page.route(/\/api\/orderbook\/heatmap(?:\?.*)?$/, async (route) => {
const q = new URL(route.request().url()).searchParams;
expect(q.get("base")).toBe("BTC");
expect(q.get("source")).toBe("single");
expect(q.get("resolution")).toBe("15m");
expect(q.get("bucketStep")).toBe("50");
expect(q.get("minBtc")).toBe("16");
const from = Number(q.get("from")), to = Number(q.get("to"));
expect(Number.isFinite(from) && to >= from).toBe(true);
await route.fulfill({ contentType: "application/json", body: JSON.stringify({
ok: true, data: {
schemaVersion: 1, generatedAt: FROZEN_NOW, base: "BTC", source: "single",
resolution: "15m", bucketStep: 50, from, to,
bars: bars.filter((bar) => bar.t >= from && bar.t <= to).map((bar) => ({
t: bar.t,

cells: empty ? [] : [[50, 0, 0], [100, 2000, 2000], [200, 7200, 7200]],
})),
},
}) });
acknowledgements++;
});
await openHarness(page, "?chart=BINANCE_FUTURES:btcusdt&timeframe=15m&priceStep=50");
const hook = page.locator(hookSelector);
await expect(hook).toHaveCount(1);
await expect(hook).toHaveAttribute("data-history-loading", "false");
await expect(hook).toHaveAttribute("data-series-len", "500");
const id = await hook.getAttribute("data-panel-id");
if (!id) throw new Error("Fixture: missing actual panel id");
await page.evaluate(async (id) => {
const { getChartRuntime } = await import("/harness/chart.ts");
const { updateOrderbookHeatmapSettings, setOrderbookHeatmapModeFor } =
await import("/harness/chart.ts");
const { settings } = await import("/src/core/settings.ts");
const r = getChartRuntime(id) as unknown as RuntimeProbe;
if (!r || !r.session || typeof r.session.captureCompositePng !== "function"
|| typeof r.invalidate !== "function" || !r.orderbookHeatmap
|| typeof r.getCaptureReadiness !== "function"
|| typeof r.subscribeCaptureReadiness !== "function") {
throw new Error("Fixture: current runtime/capture contracts unavailable");
}
if (r.getState().market !== "BINANCE_FUTURES:btcusdt") throw new Error("Fixture: wrong market");
if (r.heatmapTexturePrototypeEnabled === true) throw new Error("Private opt-in must default false");
settings.grid = false;
r.updateState({ ...r.getState(), chartType: "candlestick" });

const selection = r.getState();
let stopReadiness: (() => void) | undefined;
let readinessDeadline: ReturnType<typeof setTimeout> | undefined;
try {
await new Promise<void>((resolve, reject) => {
readinessDeadline = setTimeout(() => reject(new Error(
"Fixture: public history-settled deadline exceeded",
)), 10_000);
stopReadiness = r.subscribeCaptureReadiness((snapshot) => {
if (snapshot.disposed || snapshot.market !== selection.market
|| snapshot.timeframe !== selection.timeframe) {
reject(new Error("Fixture: history readiness selection changed"));
} else if (snapshot.history.market === selection.market
&& snapshot.history.timeframe === selection.timeframe) {
if (snapshot.history.status === "settled") resolve();
else if (snapshot.history.status === "failed") {
reject(new Error("Fixture: public history readiness failed"));
}
}
});
});
} finally {
if (readinessDeadline !== undefined) clearTimeout(readinessDeadline);
stopReadiness?.();
}
const settled = r.getCaptureReadiness();
if (settled.disposed || settled.history.status !== "settled"
|| settled.history.market !== selection.market
|| settled.history.timeframe !== selection.timeframe) {
throw new Error("Fixture: public history settlement was superseded");
}
const s = r.pipeline.series;
const root = document.querySelector(`[data-testid="chart-hook"][data-panel-id="${id}"]`)?.parentElement;
const gpu = root?.querySelector<HTMLCanvasElement>('canvas[data-chart-surface="gpu-scene"]');
const annotation = root?.querySelector<HTMLCanvasElement>('canvas[data-chart-surface="annotation"]');
if (s.length !== 500 || !gpu || !annotation || gpu.width <= 1 || gpu.height <= 1
|| annotation.width !== gpu.width || annotation.height !== gpu.height
|| r.view.area.width <= 1 || r.view.area.height <= 1) {
throw new Error("Fixture: nonempty history and valid owned surfaces required");
}

r.invalidate();
const firstPaint = await r.session.captureCompositePng();
if (firstPaint.width !== gpu.width || firstPaint.height !== gpu.height
|| firstPaint.blob.size === 0 || r.session.pendingCapture) {
throw new Error("Fixture: initial owned first paint did not complete");
}
r.setVisibleTimeRange({ from: s.timeOfIndex(455), to: s.timeOfIndex(505) });

await r.session.captureCompositePng();

const v = r.view, last = s.length - 1;
if (32 < v.minimumBarSpacing() || 32 > v.timeScaleOptions.maxBarSpacing) {
throw new Error("Fixture: calibrated spacing outside existing view bounds");
}
v.colWidth = 32;
v.offsetX = v.area.width - (last + 3) * v.colWidth;
r.invalidate();
const calibratedPaint = await r.session.captureCompositePng();
const right = v.area.left + v.area.width;
if (calibratedPaint.width !== gpu.width || calibratedPaint.height !== gpu.height
|| calibratedPaint.blob.size === 0 || r.session.pendingCapture || v.colWidth <= 12
|| v.colWidth !== 32 || Math.abs(v.xOfIndex(last) - (right - 96)) > 0.01
|| Math.abs(v.xOfIndex(last) + v.colWidth - (right - 64)) > 0.01) {
throw new Error("Fixture: calibrated owned native frame geometry is not stable");
}
updateOrderbookHeatmapSettings({
unit: "btc", bucketStep: 50,
single: { usd: 0, btc: 16 },
});
setOrderbookHeatmapModeFor(r.getState().market, "single");
r.invalidate();
}, id);
await expect.poll(() => acknowledgements).toBeGreaterThan(0);
await expect.poll(() => page.evaluate(async ({ id, empty }) => {
const { getChartRuntime } = await import("/harness/chart.ts");
const r = getChartRuntime(id) as unknown as RuntimeProbe;
const book = r.orderbookHeatmap, s = r.pipeline.series;
const tail = book.bars.get(s.timeOfIndex(s.length - 1));
return !!tail && (empty ? tail.cells.length === 0 : tail.cells.length === 3)
&& book.inFlight.size === 0 && book.chunks.size > 0
&& [...book.chunks.values()].every((chunk) => chunk.status === "ready");
}, { id, empty })).toBe(true);
return id;
}

async function capture(page: Page, id: string, enable?: boolean): Promise<Frame> {
return page.evaluate(async ({ id, enable }) => {
const { getChartRuntime } = await import("/harness/chart.ts");
const r = getChartRuntime(id) as unknown as RuntimeProbe;
const flagDescriptor = Object.getOwnPropertyDescriptor(r, "heatmapTexturePrototypeEnabled");
if (enable !== undefined) r.heatmapTexturePrototypeEnabled = enable;
const hook = document.querySelector(`[data-testid="chart-hook"][data-panel-id="${id}"]`);
const root = hook?.parentElement;
const gpu = root?.querySelector<HTMLCanvasElement>('canvas[data-chart-surface="gpu-scene"]');
const annotation = root?.querySelector<HTMLCanvasElement>('canvas[data-chart-surface="annotation"]');
if (!gpu || !annotation) throw new Error("Fixture: missing owned surfaces");
const history = r.getCaptureReadiness();
if (history.disposed || history.history.status !== "settled"
|| history.history.market !== r.getState().market
|| history.history.timeframe !== r.getState().timeframe) {
throw new Error("Fixture: capture requires public settled history");
}
const session = r.session, gl = session.gl;
const preserve = gl.getContextAttributes()?.preserveDrawingBuffer;
let ownedPixels: Uint8Array | undefined, reads = 0;

const diagnostic = () => {
const v = r.view, s = r.pipeline.series, book = r.orderbookHeatmap;
const last = s.length - 1, x = v.xOfIndex(last), right = v.area.left + v.area.width;
return {
colWidth: v.colWidth, offsetX: v.offsetX, last, time: s.timeOfIndex(last),
area: { ...v.area }, x, mainEnd: x + v.colWidth, right, gap: right - x - v.colWidth,
inFlight: book.inFlight.size, bars: book.bars.size,
chunks: [...book.chunks.entries()].slice(0, 4), chunkCount: book.chunks.size,
tailCells: book.bars.get(s.timeOfIndex(last))?.cells.length,
current: r.getState().market, historyLoading: hook?.getAttribute("data-history-loading"),
seriesLen: hook?.getAttribute("data-series-len"), enabled: r.heatmapTexturePrototypeEnabled === true,
};
};
let ownerFrame: ReturnType<typeof diagnostic> | undefined;
const descriptor = Object.getOwnPropertyDescriptor(gl, "readPixels");
const original = gl.readPixels;

gl.readPixels = function (...args: Parameters<WebGL2RenderingContext["readPixels"]>) {
const result = original.apply(this, args);
if (session.pendingCapture) {
const target = args[6];
if (!(target instanceof Uint8Array)) throw new Error("Fixture: unexpected native snapshot buffer");
ownedPixels = target.slice(); reads++; ownerFrame = diagnostic();
}
return result;
} as WebGL2RenderingContext["readPixels"];

const privateRuntime = r as unknown as Record<string, any>;
const facts: Record<string, unknown>[] = [], observerErrors: string[] = [];
const counts: Record<string, number> = {};
let queryCount = 0, heatmapDepth = 0;
const restores: (() => void)[] = [];
const objects = new Map<object, number>(), bufferBytes = new Map<object, number>();
const objectId = (value: any): number | null => {
if (value == null) return null;
if (!objects.has(value)) objects.set(value, objects.size + 1);
return objects.get(value)!;
};
const first = (value: any): number[] =>
value && typeof value.length === "number" ? Array.from(value.slice(0, 8)) as number[] : [];
const query = <T,>(fn: () => T): T => {
if (++queryCount > 128) throw new Error("Diagnostic GL query budget exceeded");
return fn();
};
const record = (phase: string, data: Record<string, unknown>) => {
if (facts.length >= 128) { observerErrors.push("Diagnostic fact budget exceeded"); return; }
facts.push({ phase, at: performance.now(), ...data });
};
const observe = (fn: () => void) => {
try { fn(); } catch (error) { observerErrors.push(String(error).slice(0, 400)); }
};
const active = () => enable === true && !!session.pendingCapture && heatmapDepth > 0;
const wrap = (owner: any, key: string, factory: (original: any) => any) => {
const prior = Object.getOwnPropertyDescriptor(owner, key);
const originalMethod = owner[key];
if (typeof originalMethod !== "function") throw new Error("Diagnostic missing method: " + key);
Object.defineProperty(owner, key, { configurable: true, writable: true, value: factory(originalMethod) });
restores.push(() => {
if (prior) Object.defineProperty(owner, key, prior);
else delete owner[key];
});
};
const rects = (list: any[]) => list.slice(0, 8).map((rect) => ({
x: rect.x, yTop: rect.yTop, width: rect.width, height: rect.height,
value: rect.value, sourceMainIndex: rect.sourceMainIndex ?? null,
}));
const prepared = (frame: any) => frame ? {
mainCount: frame.main.length, extensionCount: frame.extension.length,
main: rects(frame.main), extension: rects(frame.extension),
ceiling: frame.ceiling, threshold: frame.threshold, dataKey: frame.dataKey,
} : { nullFrame: true };
const rendererResources = () => {
const renderer = privateRuntime.heatmapGpuRenderer;
return renderer ? {
disposed: renderer.disposed, gridWidth: renderer.gridWidth, gridHeight: renderer.gridHeight,
gpuInstanceCapacityBytes: renderer.gpuInstanceCapacityBytes,
densityTexture: objectId(renderer.densityTexture), validityTexture: objectId(renderer.validityTexture),
program: objectId(renderer.program), vao: objectId(renderer.vao),
instanceDataLength: renderer.instanceData?.length ?? 0,
instanceDataFirst: first(renderer.instanceData),
stagingValuesLength: renderer.stagingValues?.length ?? 0, stagingValuesFirst: first(renderer.stagingValues),
stagingValidityLength: renderer.stagingValidity?.length ?? 0, stagingValidityFirst: first(renderer.stagingValidity),
} : { missingRenderer: true };
};
const drawState = () => {
const renderer = privateRuntime.heatmapGpuRenderer;
const program = query(() => gl.getParameter(gl.CURRENT_PROGRAM)) as WebGLProgram | null;
const state: Record<string, unknown> = {
currentProgram: objectId(program), expectedProgram: objectId(renderer?.program),
linked: program ? query(() => gl.getProgramParameter(program, gl.LINK_STATUS)) : false,
vao: objectId(query(() => gl.getParameter(gl.VERTEX_ARRAY_BINDING))),
arrayBuffer: objectId(query(() => gl.getParameter(gl.ARRAY_BUFFER_BINDING))),
arrayBufferBytes: query(() => gl.getBufferParameter(gl.ARRAY_BUFFER, gl.BUFFER_SIZE)),
viewport: first(query(() => gl.getParameter(gl.VIEWPORT))),
scissor: first(query(() => gl.getParameter(gl.SCISSOR_BOX))),
colorMask: Array.from(query(() => gl.getParameter(gl.COLOR_WRITEMASK))),
scissorTest: query(() => gl.getParameter(gl.SCISSOR_TEST)),
rasterizerDiscard: query(() => gl.getParameter(gl.RASTERIZER_DISCARD)),
depthTest: query(() => gl.getParameter(gl.DEPTH_TEST)),
stencilTest: query(() => gl.getParameter(gl.STENCIL_TEST)),
cullFace: query(() => gl.getParameter(gl.CULL_FACE)),
framebuffer: objectId(query(() => gl.getParameter(gl.FRAMEBUFFER_BINDING))),
drawingBuffer: [gl.drawingBufferWidth, gl.drawingBufferHeight],
resources: rendererResources(),
};
if (program && renderer) {
state.uniforms = ["uResolution", "uThreshold", "uLogSpan", "uDensity", "uValidity"].map((name) => {
const value = query(() => gl.getUniform(program, renderer[name]));
return { name, value: typeof value === "number" ? value : first(value) };
});
state.attributes = ["a_unit", "a_rect", "a_texel", "a_alphaScale"].map((name) => {
const index = query(() => gl.getAttribLocation(program, name));
if (index < 0) return { name, index };
const buffer = query(() => gl.getVertexAttrib(index, gl.VERTEX_ATTRIB_ARRAY_BUFFER_BINDING));
return { name, index, buffer: objectId(buffer), bufferBytes: bufferBytes.get(buffer) ?? null,
enabled: query(() => gl.getVertexAttrib(index, gl.VERTEX_ATTRIB_ARRAY_ENABLED)),
size: query(() => gl.getVertexAttrib(index, gl.VERTEX_ATTRIB_ARRAY_SIZE)),
type: query(() => gl.getVertexAttrib(index, gl.VERTEX_ATTRIB_ARRAY_TYPE)),
stride: query(() => gl.getVertexAttrib(index, gl.VERTEX_ATTRIB_ARRAY_STRIDE)),
divisor: query(() => gl.getVertexAttrib(index, gl.VERTEX_ATTRIB_ARRAY_DIVISOR)),
offset: query(() => gl.getVertexAttribOffset(index, gl.VERTEX_ATTRIB_ARRAY_POINTER)),
};
});
}
const previousUnit = query(() => gl.getParameter(gl.ACTIVE_TEXTURE));
const bindings = [];
try {
for (const unit of [0, 1]) {
gl.activeTexture(gl.TEXTURE0 + unit);
const texture = query(() => gl.getParameter(gl.TEXTURE_BINDING_2D));
bindings.push({ unit, texture: objectId(texture),
sampler: objectId(query(() => gl.getParameter(gl.SAMPLER_BINDING))),
parameters: texture ? [
gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER, gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T,
].map((parameter) => query(() => gl.getTexParameter(gl.TEXTURE_2D, parameter))) : [],
});
}
} finally { gl.activeTexture(previousUnit); }
state.samplerBindings = bindings;
return state;
};
const installObservers = () => {
if (enable !== true) return;
wrap(privateRuntime, "prepareHeatmapGpuCells", (originalMethod) => function (this: any, ...args: any[]) {
const result = originalMethod.apply(this, args);
if (session.pendingCapture) observe(() => {
counts.prepareHeatmapGpuCells = (counts.prepareHeatmapGpuCells ?? 0) + 1;
record("runtime-prepare-result", prepared(result));
});
return result;
});
wrap(r.orderbookHeatmap, "prepareGpuCells", (originalMethod) => function (this: any, ...args: any[]) {
const result = originalMethod.apply(this, args);
if (session.pendingCapture) observe(() => {
counts.prepareGpuCells = (counts.prepareGpuCells ?? 0) + 1;
record("overlay-prepare-result", prepared(result));
});
return result;
});
wrap(privateRuntime, "renderHeatmapGpuCells", (originalMethod) => function (this: any, ...args: any[]) {
const measured = !!session.pendingCapture;
if (measured) heatmapDepth++;
try { return originalMethod.apply(this, args); }
finally {
if (measured) {
observe(() => {
counts.renderHeatmapGpuCells = (counts.renderHeatmapGpuCells ?? 0) + 1;
record("runtime-render-return", {
input: prepared(args[0]), failureLatched: privateRuntime.heatmapGpuFailureLatched,
completedClaim: !!privateRuntime.heatmapGpuFrame, resources: rendererResources(),
});
});
heatmapDepth--;
}
}
});
for (const key of ["texImage2D", "texSubImage2D", "bufferData", "bufferSubData", "drawArraysInstanced"]) {
wrap(gl, key, (originalMethod) => function (this: WebGL2RenderingContext, ...args: any[]) {
const measured = active();
let beforeError: number | null = null, afterError: number | null = null;
if (measured) observe(() => {
beforeError = query(() => gl.getError());
if (key === "drawArraysInstanced") record("draw-state-before", drawState());
});

const result = originalMethod.apply(this, args);
if (measured) observe(() => {
afterError = query(() => gl.getError());
counts[key] = (counts[key] ?? 0) + 1;
if (key === "drawArraysInstanced") {
record(key, { mode: args[0], first: args[1], count: args[2], instanceCount: args[3], beforeError, afterError });
} else if (key === "texImage2D" || key === "texSubImage2D") {
const source = args[8];
record(key, { target: args[0], level: args[1], internalFormat: key === "texImage2D" ? args[2] : null,
width: args[key === "texImage2D" ? 3 : 4], height: args[key === "texImage2D" ? 4 : 5],
format: args[6], type: args[7], sourceType: source?.constructor?.name ?? "null",
sourceLength: source?.length ?? 0, sourceFirst: first(source), beforeError, afterError });
} else {
const source = args[key === "bufferData" ? 1 : 2];
const buffer = query(() => gl.getParameter(gl.ARRAY_BUFFER_BINDING));
if (key === "bufferData" && buffer) {
bufferBytes.set(buffer, typeof source === "number" ? source : source.byteLength);
}
record(key, { target: args[0], offset: key === "bufferSubData" ? args[1] : null,
buffer: objectId(buffer), byteLength: typeof source === "number" ? source : source?.byteLength ?? 0,
sourceFirst: typeof source === "number" ? [] : first(source), beforeError, afterError });
}
});
return result;
});
}
};

try {
installObservers();
r.invalidate(); // Existing full GPU+annotation invalidation, not a custom draw.
const frame = await session.captureCompositePng();
if (!ownedPixels || reads !== 1 || frame.width !== gpu.width || frame.height !== gpu.height) {
throw new Error("Fixture: no single owned in-frame snapshot");
}
const postHistory = r.getCaptureReadiness();
if (postHistory.disposed || postHistory.history.status !== "settled"
|| postHistory.selectionGeneration !== history.selectionGeneration
|| postHistory.history.generation !== history.history.generation
|| postHistory.market !== history.market || postHistory.timeframe !== history.timeframe) {
throw new Error("Fixture: history changed during owned capture");
}
const dpr = annotation.ownerDocument.defaultView!.devicePixelRatio;
const v = r.view, s = r.pipeline.series, i = s.length - 1;
if (v.colWidth <= 12) throw new Error("Fixture: main-cell interior is not resolvable");
const x = v.xOfIndex(i), right = v.area.left + v.area.width;
const mainEnd = x + v.colWidth;

if (v.colWidth !== 32 || Math.abs(x - (right - 96)) > 0.01
|| !(mainEnd < right - 32) || right - mainEnd < 64 - 0.01
|| r.orderbookHeatmap.inFlight.size !== 0) {
throw new Error("Fixture: quiet calibrated MAIN and genuine future gap required; texture-heatmap-diagnostic " + JSON.stringify({ ownerFrame, continuation: diagnostic() }));
}
const extensionX = (mainEnd + right) / 2;
const points = [
[x + v.colWidth * 0.2, v.yOfPrice(125)],
[extensionX, v.yOfPrice(125)],
[x + v.colWidth * 0.2, v.yOfPrice(75)],
[extensionX, v.yOfPrice(175)], // ABSENT bucket, unlike the explicit zero.
].map(([px, py]) => [Math.floor(px * dpr), Math.floor(py * dpr)]);
for (const [px, py] of points) {
if (px < v.area.left * dpr + 2 || px >= right * dpr - 2
|| py < v.area.top * dpr + 2 || py >= (v.area.top + v.area.height) * dpr - 2) {
throw new Error("Fixture: sample outside plot inset");
}
}
const gpuPixel = (px: number, py: number) =>
Array.from(ownedPixels!.slice(((gpu.height - 1 - py) * gpu.width + px) * 4,
((gpu.height - 1 - py) * gpu.width + px) * 4 + 4));
const ctx = annotation.getContext("2d");
if (!ctx) throw new Error("Fixture: missing actual annotation");
const image = ctx.getImageData(0, 0, annotation.width, annotation.height);
const annPixel = (px: number, py: number) =>
Array.from(image.data.slice((py * annotation.width + px) * 4, (py * annotation.width + px) * 4 + 4));
const bitmap = await createImageBitmap(frame.blob);
const scratch = document.createElement("canvas");
scratch.width = frame.width; scratch.height = frame.height;
const composite = scratch.getContext("2d")!;
composite.drawImage(bitmap, 0, 0); bitmap.close();
const candle = gpuPixel(Math.floor((x + v.colWidth / 2) * dpr), Math.floor(v.yOfPrice(255) * dpr));
let rightInk = 0, bottomInk = 0;
for (let py = 0; py < annotation.height; py++) for (let px = 0; px < annotation.width; px++) {
const o = (py * annotation.width + px) * 4;
if (image.data[o + 3] > 0 && Math.max(image.data[o], image.data[o + 1], image.data[o + 2]) > 80) {
if (px > (v.area.left + v.area.width) * dpr) rightInk++;
if (py > (v.area.top + v.area.height) * dpr) bottomInk++;
}
}

const literalCanvas = document.createElement("canvas");
literalCanvas.width = 1; literalCanvas.height = 1;
const literalCtx = literalCanvas.getContext("2d")!;
const nativeOracle = [
"rgba(77, 145, 234, 0.615)",
"rgba(77, 145, 234, 0.277)",
"rgba(125, 211, 252, 0.28)",
].map((css) => {
literalCtx.clearRect(0, 0, 1, 1);
literalCtx.fillStyle = css;
literalCtx.fillRect(0, 0, 1, 1);
return Array.from(literalCtx.getImageData(0, 0, 1, 1).data);
});
let nativeHash = 2166136261;
for (const value of ownedPixels) nativeHash = Math.imul(nativeHash ^ value, 16777619) >>> 0;
const observation = {
queryCount, facts, counts, observerErrors, ownerFrame, ownerReadCount: reads,
nativeBufferHash: nativeHash.toString(16).padStart(8, "0"),
nativeBufferLength: ownedPixels.length,
nativeBufferSize: [gpu.width, gpu.height],
captureBlobSize: frame.blob.size,
generation: [history.selectionGeneration, history.history.generation],
postGeneration: [postHistory.selectionGeneration, postHistory.history.generation],
dataKey: (r.orderbookHeatmap as any).currentDataKey(),
barsRevision: (r.orderbookHeatmap as any).barsRevision,
bookBars: r.orderbookHeatmap.bars.size, tailCells: r.orderbookHeatmap.bars.get(s.timeOfIndex(i))?.cells.slice(0, 8),
panelId: hook?.getAttribute("data-panel-id"), enabled: r.heatmapTexturePrototypeEnabled === true,
};
if (observerErrors.length) throw new Error("Diagnostic observer failure: " + JSON.stringify(observerErrors));
return {
observation,
enabled: r.heatmapTexturePrototypeEnabled === true, reads, preserve, nativeOracle,
gpu: points.map(([px, py]) => gpuPixel(px, py)),
annotation: points.map(([px, py]) => annPixel(px, py)),
composite: points.map(([px, py]) => Array.from(composite.getImageData(px, py, 1, 1).data)),
candle, axes: [rightInk, bottomInk],
geometry: [gpu.width, gpu.height, dpr, v.colWidth, x, right, v.yOfPrice(125), mainEnd, extensionX, v.offsetX],
};
} finally {
const restorationErrors: string[] = [];
const restoreSafely = (fn: () => void) => {
try { fn(); } catch (error) { restorationErrors.push(String(error)); }
};
for (const restore of restores.reverse()) restoreSafely(restore);
restoreSafely(() => {
if (flagDescriptor) Object.defineProperty(r, "heatmapTexturePrototypeEnabled", flagDescriptor);
else delete r.heatmapTexturePrototypeEnabled;
});
restoreSafely(() => {
if (descriptor) Object.defineProperty(gl, "readPixels", descriptor);
else delete (gl as Partial<WebGL2RenderingContext>).readPixels;
});
if (restorationErrors.length) throw new Error("Diagnostic restoration failed: " + restorationErrors.join("; "));
}
}, { id, enable });
}

function near(actual: number[], expected: number[], tolerance: number): void {
expect(actual).toHaveLength(expected.length);
expected.forEach((value, channel) => expect(Math.abs(actual[channel] - value)).toBeLessThanOrEqual(tolerance));
}
function controls(frame: Frame): void {
expect(frame.reads).toBe(1);
expect(frame.preserve).toBe(false);
near(frame.gpu[3], [18, 20, 26, 255], 1);
near(frame.candle, [69, 219, 158, 255], 1);
frame.axes.forEach((ink) => expect(ink).toBeGreaterThan(20));
}
function cpuCells(frame: Frame): void {

const premultiplied = [[47, 89, 144], [21, 40, 65], [35, 59, 71]];
const alpha = [0.615, 0.277, 0.28];
frame.nativeOracle.forEach((rgba, index) => {
near(rgba.slice(0, 3).map((c) => Math.round(c * rgba[3] / 255)), premultiplied[index], 1);
expect(Math.abs(rgba[3] - alpha[index] * 255)).toBeLessThanOrEqual(2);
});
near(frame.annotation[0].slice(0, 3), frame.nativeOracle[0].slice(0, 3), 1);
expect(Math.abs(frame.annotation[0][3] - 0.615 * 255)).toBeLessThanOrEqual(2);
near(frame.annotation[1].slice(0, 3), frame.nativeOracle[1].slice(0, 3), 1);
expect(Math.abs(frame.annotation[1][3] - 0.277 * 255)).toBeLessThanOrEqual(2);
near(frame.annotation[2].slice(0, 3), frame.nativeOracle[2].slice(0, 3), 1);
expect(Math.abs(frame.annotation[2][3] - 0.28 * 255)).toBeLessThanOrEqual(2);
expect(frame.annotation[3][3]).toBe(0);
}

const diagnosticTitle = "DIAGNOSTIC_COLLECTED_NOT_FEATURE_ACCEPTANCE: bounded actual native GPU diagnosis";
test(diagnosticTitle, async ({ page }) => {
const id = await prepare(page, false);
const legacy = await capture(page, id);
expect(legacy.enabled).toBe(false);
controls(legacy); cpuCells(legacy);
legacy.gpu.forEach((pixel) => near(pixel, [18, 20, 26, 255], 1));
near(legacy.composite[0], [54, 97, 154, 255], 3);
near(legacy.composite[1], [34, 55, 84, 255], 3);
near(legacy.composite[2], [48, 73, 89, 255], 3);
const native = await capture(page, id, true);
expect(native.enabled).toBe(true);
controls(native);
expect(native.geometry).toEqual(legacy.geometry);
expect(native.candle).toEqual(legacy.candle);
expect(native.axes).toEqual(legacy.axes);
expect(native.observation.generation).toEqual(legacy.observation.generation);
expect(native.observation.postGeneration).toEqual(native.observation.generation);
expect(native.observation.ownerFrame.enabled).toBe(true);
expect(legacy.observation.queryCount).toBe(0);
expect(legacy.observation.facts).toHaveLength(0);
const report = {
schemaVersion: 1, classification: "DIAGNOSTIC_COLLECTED_NOT_FEATURE_ACCEPTANCE",
qualification: "software WebGL test-only observation; no feature or physical GPU performance acceptance",
sourceSHA: process.env.SOURCE_SHA, eventSHA: process.env.GITHUB_SHA,
runID: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT,
legacy, native,
};
const scan = (value: unknown): void => {
if (typeof value === "number") expect(Number.isFinite(value), "finite diagnostic numbers").toBe(true);
else if (Array.isArray(value)) value.forEach(scan);
else if (value && typeof value === "object") Object.values(value).forEach(scan);
};
scan(report);
const serialized = JSON.stringify(report);
expect(Buffer.byteLength(serialized, "utf8"), "bounded diagnostic metadata").toBeLessThanOrEqual(32 * 1024);
expect(native.observation.queryCount).toBeLessThanOrEqual(128);
expect(native.observation.queryCount).toBeGreaterThanOrEqual(0);
expect(native.observation.facts.length).toBeLessThanOrEqual(128);
expect(native.observation.observerErrors).toEqual([]);
expect(native.observation.counts.prepareHeatmapGpuCells).toBe(1);
expect(native.observation.counts.renderHeatmapGpuCells).toBe(1);
expect(native.observation.nativeBufferLength).toBe(native.geometry[0] * native.geometry[1] * 4);
expect(native.observation.nativeBufferHash).toMatch(/^[0-9a-f]{8}$/);
expect(native.observation.ownerReadCount).toBe(1);

console.log("texture-heatmap-bounded-diagnostic " + serialized);
});
