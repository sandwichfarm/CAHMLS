import { describe, expect, it } from "vitest";
import { calculateOverlayPosition } from "../../src/lib/viewport-overlay";

describe("calculateOverlayPosition", () => {
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
