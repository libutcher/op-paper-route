import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IdleTimer } from "./idle.js";

describe("IdleTimer", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("fires once the period passes with no activity", () => {
    const onIdle = vi.fn();
    const idle = new IdleTimer(1000, onIdle);
    idle.touch();
    vi.advanceTimersByTime(999);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it("restarts the countdown on each touch", () => {
    const onIdle = vi.fn();
    const idle = new IdleTimer(1000, onIdle);
    idle.touch();
    vi.advanceTimersByTime(800);
    idle.touch();
    vi.advanceTimersByTime(800);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(200);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it("never fires while work is in flight, then counts the finish as activity", () => {
    const onIdle = vi.fn();
    const idle = new IdleTimer(1000, onIdle);
    idle.touch();
    idle.busy(); // e.g. a save waiting minutes for 1Password's prompt
    vi.advanceTimersByTime(5000);
    expect(onIdle).not.toHaveBeenCalled();

    idle.done();
    vi.advanceTimersByTime(999);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it("does nothing before the first touch, and nothing after stop()", () => {
    const onIdle = vi.fn();
    const idle = new IdleTimer(1000, onIdle);
    vi.advanceTimersByTime(5000);
    expect(onIdle).not.toHaveBeenCalled();

    idle.touch();
    idle.stop();
    vi.advanceTimersByTime(5000);
    expect(onIdle).not.toHaveBeenCalled();
  });
});
