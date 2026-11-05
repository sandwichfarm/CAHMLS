// Node 25 exposes an experimental process-wide `localStorage`, which can
// shadow jsdom's Storage and is incomplete in test workers. Use one small,
// deterministic Storage implementation for both browser and node test files.
const values = new Map<string, string>();
const testStorage: Storage = {
  get length() { return values.size; },
  clear: () => values.clear(),
  getItem: (key) => values.get(key) ?? null,
  key: (index) => [...values.keys()][index] ?? null,
  removeItem: (key) => values.delete(key),
  setItem: (key, value) => values.set(key, String(value)),
};

Object.defineProperty(globalThis, "localStorage", { configurable: true, value: testStorage });
