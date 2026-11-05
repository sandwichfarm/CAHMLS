import { vi } from "vitest";
import type { RunningTransport } from "../../src/server/transport.js";
import type { CoordinatorRuntimeConfig, CoordinatorRuntimeDeps } from "../../src/runtime/coordinator-runtime.js";
import type { InstanceLease } from "../../src/runtime/single-instance-guard.js";

export function createTestConfig(overrides: Partial<CoordinatorRuntimeConfig> = {}): CoordinatorRuntimeConfig {
  return {
    isSetupComplete: true,
    coordinatorName: "Test coordinator",
    enabledRelayUrls: ["wss://relay.example"],
    inviteRelayUrls: ["wss://relay.example"],
    coordinatorOptions: { announce: false, maxUsers: 8, coordinatorName: "Test coordinator" },
    runtimeRevision: 1,
    lock: vi.fn(),
    completeSetup: vi.fn(() => true),
    setCoordinatorName: vi.fn(() => true),
    resetToDefaults: vi.fn(),
    ...overrides,
  };
}

export function createFakeTransport(): RunningTransport & { close: ReturnType<typeof vi.fn> } {
  return { close: vi.fn(), coordinator: {} } as unknown as RunningTransport & { close: ReturnType<typeof vi.fn> };
}

export function createRuntimeDeps(overrides: Partial<CoordinatorRuntimeDeps> = {}) {
  const leases: Array<InstanceLease & { release: ReturnType<typeof vi.fn> }> = [];
  const transports: Array<RunningTransport & { close: ReturnType<typeof vi.fn> }> = [];
  const deps = {
    acquireInstanceLease: vi.fn<CoordinatorRuntimeDeps["acquireInstanceLease"]>(async () => {
      const lease = { release: vi.fn(async () => undefined) };
      leases.push(lease);
      return lease;
    }),
    createTransport: vi.fn<CoordinatorRuntimeDeps["createTransport"]>(async () => {
      const transport = createFakeTransport();
      transports.push(transport);
      return transport;
    }),
    closeTransport: vi.fn<CoordinatorRuntimeDeps["closeTransport"]>((transport) => transport.close()),
    startResourceMonitor: vi.fn<CoordinatorRuntimeDeps["startResourceMonitor"]>(),
    stopResourceMonitor: vi.fn<CoordinatorRuntimeDeps["stopResourceMonitor"]>(),
    wait: vi.fn<CoordinatorRuntimeDeps["wait"]>(async () => undefined),
    runAttempt: vi.fn<CoordinatorRuntimeDeps["runAttempt"]>(async (operation, _timeout, signal) => operation(signal)),
    profilePublisher: vi.fn<CoordinatorRuntimeDeps["profilePublisher"]>(async () => undefined),
    ...overrides,
  };
  return { deps, leases, transports };
}
