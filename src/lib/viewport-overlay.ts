export type OverlaySide = "above" | "below";
export type OverlayAlignment = "start" | "end";

export interface OverlayAnchorRect {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface OverlayPositionInput {
  viewportWidth: number;
  viewportHeight: number;
  anchor: OverlayAnchorRect;
  overlayWidth: number;
  overlayHeight: number;
  preferredSide?: OverlaySide;
  align?: OverlayAlignment;
  gutter?: number;
  gap?: number;
  compactSheet?: boolean;
  sheet?: boolean;
}

export interface OverlayPosition {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
  side: OverlaySide | "sheet";
}

export interface ViewportOverlayOptions {
  anchor: HTMLElement | undefined;
  preferredSide?: OverlaySide;
  align?: OverlayAlignment;
  gutter?: number;
  gap?: number;
  compactSheetBelow?: number;
  /** Fixed, viewport-contained sheet that deliberately ignores its anchor. */
  sheet?: boolean;
}

let activeMobileOverlay: HTMLElement | undefined;

function requestSurfaceClose(node: HTMLElement): void {
  const closeControl = node.parentElement?.querySelector<HTMLButtonElement>(
    ':scope > button[aria-label^="Close"]',
  );
  closeControl?.click();
}

export function calculateOverlayPosition(input: OverlayPositionInput): OverlayPosition {
  const gutter = input.gutter ?? 8;
  const gap = input.gap ?? 8;
  const viewportWidth = Math.max(gutter * 2, input.viewportWidth);
  const viewportHeight = Math.max(gutter * 2, input.viewportHeight);
  const width = Math.max(0, Math.min(input.overlayWidth, viewportWidth - gutter * 2));
  const fullHeight = Math.max(0, viewportHeight - gutter * 2);

  if (input.sheet || input.compactSheet) {
    const visibleHeight = Math.min(input.overlayHeight, fullHeight);
    return {
      left: gutter,
      top: Math.max(gutter, viewportHeight - gutter - visibleHeight),
      width,
      maxHeight: fullHeight,
      side: "sheet",
    };
  }

  const availableAbove = Math.max(0, input.anchor.top - gap - gutter);
  const availableBelow = Math.max(0, viewportHeight - input.anchor.bottom - gap - gutter);
  const preferred = input.preferredSide ?? "below";
  const preferredSpace = preferred === "above" ? availableAbove : availableBelow;
  const alternateSpace = preferred === "above" ? availableBelow : availableAbove;
  const side: OverlaySide = input.overlayHeight <= preferredSpace || preferredSpace >= alternateSpace
    ? preferred
    : preferred === "above" ? "below" : "above";
  const maxHeight = side === "above" ? availableAbove : availableBelow;
  const visibleHeight = Math.min(input.overlayHeight, maxHeight);
  const unclampedLeft = (input.align ?? "start") === "end"
    ? input.anchor.right - width
    : input.anchor.left;
  const left = Math.min(Math.max(gutter, unclampedLeft), viewportWidth - width - gutter);
  const top = side === "above"
    ? Math.max(gutter, input.anchor.top - gap - visibleHeight)
    : Math.min(viewportHeight - gutter - visibleHeight, input.anchor.bottom + gap);

  return { left, top, width, maxHeight, side };
}

/**
 * Promotes a floating surface into the browser top layer and positions it
 * against its trigger in viewport coordinates. Keeping the node in its
 * component subtree preserves Svelte event delegation and dialog ownership.
 */
export function viewportOverlay(node: HTMLElement, initialOptions: ViewportOverlayOptions) {
  let options = initialOptions;
  let animationFrame = 0;
  node.dataset.viewportOverlay = "true";
  node.setAttribute("popover", "manual");
  node.showPopover();

  const closeFromController = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || activeMobileOverlay !== node) return;
    event.preventDefault();
    requestSurfaceClose(node);
  };

  const position = () => {
    animationFrame = 0;
    const anchor = options.anchor;
    if (!node.isConnected || (!options.sheet && !anchor?.isConnected)) return;
    const anchorRect = anchor?.getBoundingClientRect() ?? { top: 0, right: 0, bottom: 0, left: 0 };

    node.style.position = "fixed";
    node.style.zIndex = "1000";
    node.style.inset = "auto";
    node.style.margin = "0";
    // A sheet can outlive the drawer that opened it, whose closed state disables
    // pointer events on its descendants.
    node.style.pointerEvents = "auto";
    node.style.maxWidth = `calc(100vw - ${(options.gutter ?? 8) * 2}px)`;
    node.style.width = "";
    node.style.maxHeight = "";
    const naturalRect = node.getBoundingClientRect();
    const compactSheet = options.sheet || (
      options.compactSheetBelow !== undefined
      && window.innerWidth <= options.compactSheetBelow
    );
    if (compactSheet) {
      if (activeMobileOverlay && activeMobileOverlay !== node) requestSurfaceClose(activeMobileOverlay);
      activeMobileOverlay = node;
      node.setAttribute("aria-modal", "true");
      window.dispatchEvent(new CustomEvent("cahmls:mobile-overlay-open", { detail: { node } }));
    } else if (activeMobileOverlay === node) {
      activeMobileOverlay = undefined;
      node.removeAttribute("aria-modal");
    }
    const visualHeight = window.visualViewport?.height;
    const viewportHeight = typeof visualHeight === "number" && Number.isFinite(visualHeight) && visualHeight > 0
      ? visualHeight
      : window.innerHeight;
    const result = calculateOverlayPosition({
      viewportWidth: window.innerWidth,
      viewportHeight,
      anchor: anchorRect,
      overlayWidth: compactSheet ? window.innerWidth - (options.gutter ?? 8) * 2 : naturalRect.width,
      overlayHeight: naturalRect.height,
      preferredSide: options.preferredSide,
      align: options.align,
      gutter: options.gutter,
      gap: options.gap,
      compactSheet,
      sheet: options.sheet,
    });

    node.style.left = `${result.left}px`;
    node.style.top = `${result.top}px`;
    node.style.width = `${result.width}px`;
    node.style.maxHeight = `${result.maxHeight}px`;
    node.style.overflowY = "auto";
    node.style.overscrollBehavior = "contain";
    node.dataset.overlaySide = result.side;
  };

  const schedule = () => {
    if (animationFrame) return;
    animationFrame = requestAnimationFrame(position);
  };

  window.addEventListener("resize", schedule);
  window.addEventListener("scroll", schedule, true);
  window.addEventListener("keydown", closeFromController);
  window.visualViewport?.addEventListener("resize", schedule);
  window.visualViewport?.addEventListener("scroll", schedule);
  schedule();

  return {
    update(nextOptions: ViewportOverlayOptions) {
      options = nextOptions;
      schedule();
    },
    destroy() {
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      window.removeEventListener("keydown", closeFromController);
      window.visualViewport?.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("scroll", schedule);
      if (animationFrame) cancelAnimationFrame(animationFrame);
      if (node.matches(":popover-open")) node.hidePopover();
      if (activeMobileOverlay === node) {
        activeMobileOverlay = undefined;
        window.dispatchEvent(new CustomEvent("cahmls:mobile-overlay-close", { detail: { node } }));
      }
      node.removeAttribute("aria-modal");
      delete node.dataset.viewportOverlay;
      delete node.dataset.overlaySide;
      node.removeAttribute("popover");
    },
  };
}
