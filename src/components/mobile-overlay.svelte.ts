export interface MobileOverlaySurface {
  /** Stable, route-owned identity. It is never derived from a visible label. */
  id: string;
  element: HTMLElement;
  opener?: HTMLElement | null;
  initialFocus?: HTMLElement | null;
  safeScrim?: boolean;
  onClose?: () => void;
}

export interface MobileOverlayControllerOptions {
  applicationRoot: HTMLElement;
  /** Use sibling roots when the surface is rendered inside the shell. */
  backgroundRoots?: HTMLElement[];
  fallbackFocus?: HTMLElement | null;
  history?: History;
}

interface CloseOptions {
  restoreFocus?: boolean;
  fromHistory?: boolean;
  /**
   * Leave the overlay's history entry in place for a navigation that is about to
   * replace it. Popping is asynchronous, so it would otherwise land after that
   * navigation and undo it.
   */
  keepHistory?: boolean;
}

const focusableSelector = [
  "button:not([disabled])",
  "[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(", ");

/**
 * One browser-safe owner for transient mobile modal state. Components remain
 * responsible for rendering their surfaces; this controller owns the policy
 * that prevents two surfaces or a live background from co-existing.
 */
export function createMobileOverlayController(options: MobileOverlayControllerOptions) {
  const history = options.history ?? (typeof window === "undefined" ? undefined : window.history);
  const token = `cahmls-mobile-overlay:${Math.random().toString(36).slice(2)}`;
  let active: MobileOverlaySurface | undefined;
  let ownsHistory = false;
  let destroyed = false;
  const backgroundRoots = options.backgroundRoots ?? [options.applicationRoot];

  const focusInitial = () => {
    const target = active?.initialFocus?.isConnected
      ? active.initialFocus
      : active?.element.querySelector<HTMLElement>(focusableSelector) ?? active?.element;
    target?.focus();
  };

  const trapFocus = (event: KeyboardEvent) => {
    if (event.key !== "Tab" || !active) return;
    const targets = [...active.element.querySelectorAll<HTMLElement>(focusableSelector)]
      .filter((target) => !target.hasAttribute("inert") && target.getClientRects().length > 0);
    if (targets.length === 0) {
      event.preventDefault();
      active.element.focus();
      return;
    }
    const first = targets[0];
    const last = targets.at(-1)!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const keydown = (event: KeyboardEvent) => {
    if (!active) return;
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    trapFocus(event);
  };

  const popstate = (event: PopStateEvent) => {
    if (!active || !ownsHistory) return;
    const state = event.state as { cahmlsMobileOverlay?: string } | null;
    if (state?.cahmlsMobileOverlay === token) return;
    close({ fromHistory: true });
  };

  const open = (surface: MobileOverlaySurface) => {
    if (destroyed) return;
    if (active?.id === surface.id) return;
    if (active) close({ restoreFocus: false });
    active = surface;
    for (const root of backgroundRoots) root.inert = true;
    document.addEventListener("keydown", keydown);
    window.addEventListener("popstate", popstate);
    if (history) {
      history.pushState({ ...(history.state ?? {}), cahmlsMobileOverlay: token }, "");
      ownsHistory = true;
    }
    focusInitial();
  };

  const close = (closeOptions: CloseOptions = {}) => {
    if (!active) return;
    const closing = active;
    active = undefined;
    closing.onClose?.();
    for (const root of backgroundRoots) root.inert = false;
    document.removeEventListener("keydown", keydown);
    window.removeEventListener("popstate", popstate);
    const shouldPop = ownsHistory && !closeOptions.fromHistory && !closeOptions.keepHistory;
    ownsHistory = false;
    if (shouldPop) history?.back();
    if (closeOptions.restoreFocus !== false) {
      const target = closing.opener?.isConnected ? closing.opener : options.fallbackFocus?.isConnected ? options.fallbackFocus : undefined;
      target?.focus();
    }
  };

  return {
    get activeId() { return active?.id; },
    get activeSurface() { return active; },
    open,
    replace(surface: MobileOverlaySurface) { open(surface); },
    close,
    dismissFromScrim() {
      if (active?.safeScrim) close();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      close({ restoreFocus: false });
    },
  };
}
