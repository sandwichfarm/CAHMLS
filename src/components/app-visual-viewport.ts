export interface AppVisualViewportLike {
  height: number;
  addEventListener(type: "resize" | "scroll", listener: EventListener): void;
  removeEventListener(type: "resize" | "scroll", listener: EventListener): void;
}

export interface AppVisualViewportWindow {
  visualViewport?: AppVisualViewportLike | null;
  addEventListener(type: "resize" | "scroll", listener: EventListener): void;
  removeEventListener(type: "resize" | "scroll", listener: EventListener): void;
  requestAnimationFrame(callback: FrameRequestCallback): number;
  cancelAnimationFrame(handle: number): void;
}

export interface AppVisualViewportOwner {
  destroy(): void;
}

interface ViewportController {
  owners: number;
  frame: number;
  root: HTMLElement;
  browser: AppVisualViewportWindow;
  schedule: EventListener;
  update: () => void;
}

const controllers = new WeakMap<HTMLElement, ViewportController>();

function visualHeight(browser: AppVisualViewportWindow): string {
  const height = browser.visualViewport?.height;
  return typeof height === "number" && Number.isFinite(height) && height > 0
    ? `${height}px`
    : "100dvh";
}

function scrollFocusedControlIntoView(root: HTMLElement): void {
  const focused = root.ownerDocument.activeElement;
  if (!(focused instanceof HTMLElement) || !root.contains(focused)) return;
  const form = focused.closest("form");
  const primaryAction = form?.querySelector<HTMLElement>('button[type="submit"], button:not([type])');
  const rootBounds = root.getBoundingClientRect();
  const focusedBounds = focused.getBoundingClientRect();
  const actionBounds = primaryAction?.getBoundingClientRect();
  const obscured = focusedBounds.bottom > rootBounds.bottom
    || focusedBounds.top < rootBounds.top
    || (actionBounds !== undefined && (actionBounds.bottom > rootBounds.bottom || actionBounds.top < rootBounds.top));
  if (!obscured) return;
  focused.scrollIntoView({ block: "nearest", inline: "nearest" });
  primaryAction?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

/**
 * Owns one browser VisualViewport subscription for every mounted application root.
 * The visual CSS variable starts at the dynamic viewport fallback and is only
 * measured when the browser exposes a finite VisualViewport height.
 */
export function mountAppVisualViewport(
  root: HTMLElement,
  browser: AppVisualViewportWindow = window,
): AppVisualViewportOwner {
  let controller = controllers.get(root);
  if (!controller) {
    const update = () => {
      controller!.frame = 0;
      root.style.setProperty("--app-visual-height", visualHeight(browser));
      scrollFocusedControlIntoView(root);
    };
    const schedule: EventListener = () => {
      if (controller!.frame) return;
      controller!.frame = browser.requestAnimationFrame(update);
    };
    controller = { owners: 0, frame: 0, root, browser, schedule, update };
    controllers.set(root, controller);
    root.style.setProperty("--app-visual-height", "100dvh");
    browser.addEventListener("resize", schedule);
    browser.addEventListener("scroll", schedule);
    browser.visualViewport?.addEventListener("resize", schedule);
    browser.visualViewport?.addEventListener("scroll", schedule);
    schedule(new Event("resize"));
  }
  controller.owners += 1;

  return {
    destroy() {
      const current = controllers.get(root);
      if (!current) return;
      current.owners -= 1;
      if (current.owners > 0) return;
      current.browser.removeEventListener("resize", current.schedule);
      current.browser.removeEventListener("scroll", current.schedule);
      current.browser.visualViewport?.removeEventListener("resize", current.schedule);
      current.browser.visualViewport?.removeEventListener("scroll", current.schedule);
      if (current.frame) current.browser.cancelAnimationFrame(current.frame);
      controllers.delete(root);
    },
  };
}
