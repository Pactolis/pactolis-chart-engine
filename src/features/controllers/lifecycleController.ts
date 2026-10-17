export interface Controller {
  start(): void | Promise<void>;
  dispose(): void;
}

export class LifecycleController implements Controller {
  private readonly disposers: (() => void)[] = [];
  private started = false;

  start(): void {
    this.started = true;
  }

  add(disposer: () => void): () => void {
    if (!this.started) this.start();
    this.disposers.push(disposer);
    return disposer;
  }

  interval(callback: () => void, ms: number): number {
    const id = window.setInterval(callback, ms);
    this.add(() => window.clearInterval(id));
    return id;
  }

  timeout(callback: () => void, ms: number): number {
    const id = window.setTimeout(callback, ms);
    this.add(() => window.clearTimeout(id));
    return id;
  }

  listen<K extends keyof WindowEventMap>(
    target: Window,
    type: K,
    listener: (event: WindowEventMap[K]) => void
  ): void {
    target.addEventListener(type, listener as EventListener);
    this.add(() => target.removeEventListener(type, listener as EventListener));
  }

  dispose(): void {
    for (const dispose of this.disposers.splice(0).reverse()) dispose();
    this.started = false;
  }
}
