/** Debounced, opt-in source refresh. Explicit and automatic exports share one slot. */
export class SqlmeshRefreshCoordinator {
  private timer?: ReturnType<typeof setTimeout>;
  private active?: { controller: AbortController; automatic: boolean };
  private pending = false;
  private disposed = false;

  constructor(private readonly options: {
    enabled: () => boolean;
    refresh: (signal: AbortSignal) => Promise<unknown>;
    onError: (error: unknown) => void;
    delayMs?: number;
  }) {}

  changed(): void {
    if (this.disposed || !this.options.enabled()) return;
    this.pending = true;
    this.schedule();
  }

  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.disposed || !this.options.enabled()) { this.pending = false; return; }
      if (this.active || !this.pending) return;
      this.pending = false;
      void this.run(this.options.refresh, true).catch(error => {
        if (!this.disposed && this.options.enabled() && !this.pending) this.options.onError(error);
      });
    }, this.options.delayMs ?? 1000);
  }

  async run<T>(action: (signal: AbortSignal) => Promise<T>, automatic = false, signal?: AbortSignal): Promise<T> {
    if (this.disposed) throw new Error('SQLMesh refresh is closed.');
    if (this.active) throw new Error('SQLMesh refresh is already running. Wait for it to finish before refreshing or inspecting again.');
    if (!automatic) { clearTimeout(this.timer); this.timer = undefined; this.pending = false; }
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) abort();
    signal?.addEventListener('abort', abort, { once: true });
    this.active = { controller, automatic };
    try { return await action(controller.signal); }
    finally {
      signal?.removeEventListener('abort', abort);
      this.active = undefined;
      if (this.pending && !this.disposed && this.options.enabled()) this.schedule();
    }
  }

  disableAutomatic(): void {
    clearTimeout(this.timer); this.timer = undefined; this.pending = false;
    if (this.active?.automatic) this.active.controller.abort();
  }

  dispose(): void {
    this.disposed = true;
    this.disableAutomatic();
    this.active?.controller.abort();
  }
}
