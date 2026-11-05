import { vi } from "vitest";
import { McpServer } from "@contextvm/mcp-sdk/server/mcp";
import { configureRoomEnvironment, createMemoryRoomStorage } from "../../src/client/room-environment.js";
import type { CoordinatorStorage } from "../../src/coordinator/storage/storage.js";

/** Give one test its own room storage. Returns the restore function. */
export function createRoomStorageFor(): () => void {
  return configureRoomEnvironment({ storage: createMemoryRoomStorage() });
}

/** A factory dependency whose server fails to connect to relays. */
export function createFakeTransportDeps(storage: CoordinatorStorage) {
  vi.spyOn(McpServer.prototype, "connect").mockRejectedValueOnce(new Error("relay offline"));
  return { createStorage: () => storage };
}
