import { configureChartLocale } from "../src/core/chartLocale.js";
import type { GpuBackendPreference } from "../src/core/gpu/gpuSettings.js";
import { ChartWorkerHostPool } from "../src/features/chart/worker/chartWorkerRuntime.js";

configureChartLocale({
  locale: () => "en-US",
  timeZone: () => "UTC",
  translate: (key) => key,
  onLocaleChange: () => () => {},
});

interface WorkerControlMessage {
  type: "attach-panel" | "dispose-panel" | "diagnostics";
  panelId: string;
  marketId?: string;
  backendPreference?: GpuBackendPreference;
  requestId?: string;
  ports?: {
    mainPort?: MessagePort;
    historyPort?: MessagePort;
    ingressPort?: MessagePort;
  };
}

const pool = new ChartWorkerHostPool();

const workerScope = globalThis as unknown as {
  addEventListener: (type: "message", listener: (event: MessageEvent<WorkerControlMessage>) => void) => void;
  postMessage: (message: unknown) => void;
};

workerScope.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || typeof data !== "object") return;

  if (data.type === "attach-panel") {
    const mainPort = data.ports?.mainPort ?? event.ports[0];
    const historyPort = data.ports?.historyPort ?? event.ports[1];
    const ingressPort = data.ports?.ingressPort ?? event.ports[2];
    if (!mainPort) return;
    const panel = pool.createPanel({
      panelId: data.panelId,
      marketId: data.marketId ?? "BINANCE_FUTURES:btcusdt",
      backendPreference: data.backendPreference ?? "auto",
    });
    panel.attachPorts({ mainPort, historyPort, ingressPort });
    workerScope.postMessage({
      type: "panel-attached",
      panelId: data.panelId,
      requestId: data.requestId,
    });
    return;
  }

  if (data.type === "dispose-panel") {
    const removed = pool.removePanel(data.panelId);
    workerScope.postMessage({
      type: "panel-disposed",
      panelId: data.panelId,
      removed,
      requestId: data.requestId,
    });
    return;
  }

  if (data.type === "diagnostics") {
    const diag = pool.getPanel(data.panelId)?.getDiagnostics() ?? null;
    workerScope.postMessage({
      type: "diagnostics",
      panelId: data.panelId,
      diagnostics: diag,
      requestId: data.requestId,
    });
  }
});
