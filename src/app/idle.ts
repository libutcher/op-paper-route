/**
 * Calls `onIdle` once `ms` passes with no activity. `touch()` marks activity
 * and restarts the wait; `busy()`/`done()` bracket work in progress, during
 * which the timer never fires (a save waiting on 1Password's prompt must not
 * count as idle). No Electron imports, so it can be tested with fake timers.
 */
export class IdleTimer {
  readonly #ms: number;
  readonly #onIdle: () => void;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #inFlight = 0;

  constructor(ms: number, onIdle: () => void) {
    this.#ms = ms;
    this.#onIdle = onIdle;
  }

  /** Activity happened: start (or restart) the idle countdown. */
  touch(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      if (this.#inFlight === 0) this.#onIdle();
      else this.touch(); // still busy; check again after another full period
    }, this.#ms);
  }

  /** Work has started; idle can't fire until the matching done(). */
  busy(): void {
    this.#inFlight++;
  }

  /** Work has finished; counts as activity. */
  done(): void {
    this.#inFlight = Math.max(0, this.#inFlight - 1);
    this.touch();
  }

  stop(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }
}
