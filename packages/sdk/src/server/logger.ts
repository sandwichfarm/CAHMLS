export interface ServerLogger {
  info(bindings: Record<string, unknown>, message: string): void;
  warn(bindings: Record<string, unknown>, message: string): void;
  error(bindings: Record<string, unknown>, message: string): void;
}

export const consoleServerLogger: ServerLogger = {
  info() {
    // Browser coordinator logs are intentionally suppressed to avoid leaking request metadata.
  },
  warn() {
    // Browser coordinator logs are intentionally suppressed to avoid leaking request metadata.
  },
  error() {
    // Browser coordinator logs are intentionally suppressed to avoid leaking request metadata.
  },
};
