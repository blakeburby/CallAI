type LogLevel = "info" | "warn" | "error" | "debug";

const serialize = (value: unknown): string => {
  if (value instanceof Error) {
    return JSON.stringify({
      name: value.name,
      message: value.message,
      stack: value.stack
    });
  }

  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const write = (level: LogLevel, message: string, meta?: unknown): void => {
  const entry = {
    level,
    message,
    timestamp: new Date().toISOString(),
    ...(meta === undefined ? {} : { meta })
  };

  const line = serialize(entry);

  if (level === "error") {
    console.error(line);
    return;
  }

  if (level === "warn") {
    console.warn(line);
    return;
  }

  console.log(line);
};

export const logger = {
  info: (message: string, meta?: unknown) => write("info", message, meta),
  warn: (message: string, meta?: unknown) => write("warn", message, meta),
  error: (message: string, meta?: unknown) => write("error", message, meta),
  debug: (message: string, meta?: unknown) => write("debug", message, meta)
};
