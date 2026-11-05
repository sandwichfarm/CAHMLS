import { describe, expect, it } from "vitest";
import { vi } from "vitest";
import { createMobileOverlayController } from "../../src/components/mobile-overlay.svelte";

function surface(id: string, opener: HTMLButtonElement, root: HTMLElement, onClose?: () => void) {
  const element = document.createElement("section");
  element.id = id;
  element.tabIndex = -1;
  root.append(element);
  return { id, element, opener, onClose };
}

describe("mobile overlay controller", () => {
  it("keeps one modal surface, inerts the app, and restores the exact opener", () => {
    const app = document.createElement("main");
    const drawerRoot = document.createElement("div");
    const opener = document.createElement("button");
    document.body.append(app, opener, drawerRoot);
    const controller = createMobileOverlayController({ applicationRoot: app });
    const drawer = surface("rooms", opener, drawerRoot);

    controller.open(drawer);
    expect(controller.activeId).toBe("rooms");
    expect(app.inert).toBe(true);

    controller.close();
    expect(controller.activeId).toBeUndefined();
    expect(app.inert).toBe(false);
    expect(document.activeElement).toBe(opener);
    controller.destroy();
  });

  it("replaces a surface only after its close callback and returns focus to fallback for a removed opener", () => {
    const app = document.createElement("main");
    const drawerRoot = document.createElement("div");
    const opener = document.createElement("button");
    const fallback = document.createElement("h1");
    fallback.tabIndex = -1;
    document.body.append(app, opener, fallback, drawerRoot);
    const closed: string[] = [];
    const controller = createMobileOverlayController({ applicationRoot: app, fallbackFocus: fallback });
    controller.open(surface("rooms", opener, drawerRoot, () => closed.push("rooms")));
    opener.remove();
    controller.replace(surface("profile", document.createElement("button"), drawerRoot));

    expect(closed).toEqual(["rooms"]);
    expect(controller.activeId).toBe("profile");
    controller.close();
    expect(document.activeElement).toBe(fallback);
    controller.destroy();
  });

  it("leaves its history entry for a navigation that will replace it", () => {
    const app = document.createElement("main");
    const drawerRoot = document.createElement("div");
    const opener = document.createElement("button");
    document.body.append(app, opener, drawerRoot);
    const back = vi.spyOn(window.history, "back");
    const controller = createMobileOverlayController({ applicationRoot: app, history: window.history });
    controller.open(surface("rooms", opener, drawerRoot));

    controller.close({ keepHistory: true });

    expect(back).not.toHaveBeenCalled();
    expect(controller.activeId).toBeUndefined();
    back.mockRestore();
    controller.destroy();
  });

  it("owns one transient history entry and consumes the first platform Back", () => {
    const app = document.createElement("main");
    const drawerRoot = document.createElement("div");
    const opener = document.createElement("button");
    document.body.append(app, opener, drawerRoot);
    const controller = createMobileOverlayController({ applicationRoot: app, history: window.history });
    controller.open(surface("rooms", opener, drawerRoot));
    window.dispatchEvent(new PopStateEvent("popstate", { state: null }));

    expect(controller.activeId).toBeUndefined();
    expect(app.inert).toBe(false);
    controller.destroy();
  });
});
