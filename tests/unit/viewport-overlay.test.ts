import { describe, expect, it } from "vitest";
import { calculateOverlayPosition } from "../../src/lib/viewport-overlay";
import { mountAppVisualViewport, type AppVisualViewportWindow } from "../../src/components/app-visual-viewport";

function createViewportWindow(height: number) {
  const listeners = new Map<string, Set<EventListener>>();
  let nextFrame = 0;
  const frames = new Map<number, FrameRequestCallback>();
  const viewportListeners = new Map<string, Set<EventListener>>();
  const visualViewport = {
    height,
    addEventListener(type: string, listener: EventListener) {
      const bucket = viewportListeners.get(type) ?? new Set<EventListener>();
      bucket.add(listener);
      viewportListeners.set(type, bucket);
    },
    removeEventListener(type: string, listener: EventListener) {
      viewportListeners.get(type)?.delete(listener);
    },
    dispatch(type: string) {
      for (const listener of viewportListeners.get(type) ?? []) listener(new Event(type));
    },
  };
  const browser: AppVisualViewportWindow = {
    visualViewport,
    addEventListener(type, listener) {
      const bucket = listeners.get(type) ?? new Set<EventListener>();
      bucket.add(listener);
      listeners.set(type, bucket);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    requestAnimationFrame(callback) {
      const id = ++nextFrame;
      frames.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id) {
      frames.delete(id);
    },
  };

  return {
    browser,
    visualViewport,
    dispatch(type: string) {
      for (const listener of listeners.get(type) ?? []) listener(new Event(type));
    },
    flush() {
      const queued = [...frames.values()];
      frames.clear();
      queued.forEach((callback) => callback(0));
    },
    listenerCount() {
      return [...listeners.values(), ...viewportListeners.values()].reduce((total, bucket) => total + bucket.size, 0);
    },
  };
}

describe("calculateOverlayPosition", () => {
  it("shares a single visual viewport frame and cleans it up after the final owner", () => {
    const fixture = createViewportWindow(430);
    const root = document.createElement("div");
    const first = mountAppVisualViewport(root, fixture.browser);
    const second = mountAppVisualViewport(root, fixture.browser);

    fixture.flush();
    expect(root.style.getPropertyValue("--app-visual-height")).toBe("430px");
    fixture.visualViewport.height = 390;
    fixture.visualViewport.dispatch("resize");
    fixture.visualViewport.dispatch("scroll");
    fixture.dispatch("resize");
    fixture.flush();
    expect(root.style.getPropertyValue("--app-visual-height")).toBe("390px");

    first.destroy();
    expect(fixture.listenerCount()).toBeGreaterThan(0);
    second.destroy();
    expect(fixture.listenerCount()).toBe(0);
  });

  it("keeps a dynamic viewport fallback when VisualViewport is unavailable", () => {
    const root = document.createElement("div");
    const browser = createViewportWindow(430).browser;
    browser.visualViewport = undefined;
    const owner = mountAppVisualViewport(root, browser);
    expect(root.style.getPropertyValue("--app-visual-height")).toBe("100dvh");
    owner.destroy();
  });

  it("keeps an end-aligned panel inside the viewport", () => {
    expect(calculateOverlayPosition({
      viewportWidth: 1_280,
      viewportHeight: 800,
      anchor: { top: 700, right: 340, bottom: 744, left: 20 },
      overlayWidth: 384,
      overlayHeight: 520,
      preferredSide: "above",
      align: "start",
    })).toEqual({ left: 20, top: 172, width: 384, maxHeight: 684, side: "above" });
  });

  it("flips below when there is more usable space below the trigger", () => {
    const result = calculateOverlayPosition({
      viewportWidth: 900,
      viewportHeight: 700,
      anchor: { top: 40, right: 880, bottom: 84, left: 760 },
      overlayWidth: 360,
      overlayHeight: 400,
      preferredSide: "above",
      align: "end",
    });

    expect(result).toEqual({ left: 520, top: 92, width: 360, maxHeight: 600, side: "below" });
  });

  it("constrains oversized panels to gutters and a scrollable height", () => {
    const result = calculateOverlayPosition({
      viewportWidth: 320,
      viewportHeight: 480,
      anchor: { top: 210, right: 312, bottom: 254, left: 8 },
      overlayWidth: 500,
      overlayHeight: 900,
      preferredSide: "below",
      align: "end",
    });

    expect(result.width).toBe(304);
    expect(result.left).toBe(8);
    expect(result.top).toBe(262);
    expect(result.maxHeight).toBe(210);
    expect(result.side).toBe("below");
  });

  it("uses a viewport-inset bottom sheet on compact screens", () => {
    expect(calculateOverlayPosition({
      viewportWidth: 375,
      viewportHeight: 520,
      anchor: { top: 430, right: 360, bottom: 474, left: 20 },
      overlayWidth: 352,
      overlayHeight: 700,
      preferredSide: "above",
      align: "start",
      compactSheet: true,
    })).toEqual({ left: 8, top: 8, width: 352, maxHeight: 504, side: "sheet" });
  });

  it("honors an explicit 16px participant gutter for compact sheets", () => {
    expect(calculateOverlayPosition({
      viewportWidth: 320,
      viewportHeight: 480,
      anchor: { top: 400, right: 300, bottom: 444, left: 20 },
      overlayWidth: 500,
      overlayHeight: 900,
      preferredSide: "above",
      align: "start",
      gutter: 16,
      compactSheet: true,
    })).toEqual({ left: 16, top: 16, width: 288, maxHeight: 448, side: "sheet" });
  });

  it("uses named sheet mode without an anchor when a mobile surface replaces a drawer", () => {
    expect(calculateOverlayPosition({
      viewportWidth: 390,
      viewportHeight: 430,
      anchor: { top: 0, right: 0, bottom: 0, left: 0 },
      overlayWidth: 600,
      overlayHeight: 600,
      gutter: 8,
      sheet: true,
    })).toEqual({ left: 8, top: 8, width: 374, maxHeight: 414, side: "sheet" });
  });

  it("keeps an explicit-gutter constrained panel inset and scrollable", () => {
    expect(calculateOverlayPosition({
      viewportWidth: 320,
      viewportHeight: 480,
      anchor: { top: 40, right: 312, bottom: 84, left: 8 },
      overlayWidth: 500,
      overlayHeight: 900,
      preferredSide: "below",
      align: "end",
      gutter: 16,
    })).toEqual({ left: 16, top: 92, width: 288, maxHeight: 372, side: "below" });
  });
});
