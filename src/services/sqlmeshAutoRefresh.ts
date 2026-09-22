/** Debounced, opt-in source refresh. Explicit and automatic exports share one slot. */
export class SqlmeshRefreshCoordinator {
  private timer?: ReturnType<typeof setTimeout>;
  private active?: { controller: AbortController; automatic: boolean; finished: Promise<void> };
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
      let signal: AbortSignal | undefined;
      void this.run(s => { signal = s; return this.options.refresh(s); }, true).catch(error => {
        if (!signal?.aborted && !this.disposed && this.options.enabled() && !this.pending) this.options.onError(error);
      });
    }, this.options.delayMs ?? 1000);
  }

  async run<T>(action: (signal: AbortSignal) => Promise<T>, automatic = false, signal?: AbortSignal): Promise<T> {
    if (this.disposed) throw new Error('SQLMesh refresh is closed.');
    const previous = this.active;
    if (previous && (automatic || !previous.automatic)) throw new Error('SQLMesh refresh is already running. Wait for it to finish before refreshing or inspecting again.');
    if (!automatic) { clearTimeout(this.timer); this.timer = undefined; this.pending = false; }
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) abort();
    signal?.addEventListener('abort', abort, { once: true });
    let finish!: () => void;
    const active = { controller, automatic, finished: new Promise<void>(resolve => { finish = resolve; }) };
    // Reserve the explicit slot before cancelling the automatic export. Wait
    // for its cleanup so both exporters can never write metadata concurrently.
    this.active = active;
    previous?.controller.abort();
    try {
      if (previous) await previous.finished;
      if (this.disposed) throw new Error('SQLMesh refresh is closed.');
      if (controller.signal.aborted) throw new Error('SQLMesh refresh cancelled.');
      return await action(controller.signal);
    }
    finally {
      signal?.removeEventListener('abort', abort);
      if (this.active === active) {
        this.active = undefined;
        if (this.pending && !this.disposed && this.options.enabled()) this.schedule();
      }
      finish();
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
