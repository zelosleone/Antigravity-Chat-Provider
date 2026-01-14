export interface Logger {
  debug(message: string, extra?: Record<string, unknown>): void;
  info(message: string, extra?: Record<string, unknown>): void;
  warn(message: string, extra?: Record<string, unknown>): void;
  error(message: string, extra?: Record<string, unknown>): void;
}

const noop = () => {};

export function createLogger(_module: string): Logger {
  return {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
  };
}
