type LogFields = Record<string, unknown>;
type LogLevel = "info" | "warn" | "error";
type LogSink = (line: string, level: LogLevel) => void;

function defaultSink(line: string, level: LogLevel): void {
  if (process.env.NODE_ENV === "test") return;
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export function createLogger(sink: LogSink = defaultSink) {
  const write = (level: LogLevel, event: string, fields: LogFields = {}) => {
    sink(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level,
        event,
        ...fields
      }),
      level
    );
  };
  return {
    info(event: string, fields?: LogFields) {
      write("info", event, fields);
    },
    warn(event: string, fields?: LogFields) {
      write("warn", event, fields);
    },
    error(event: string, fields?: LogFields) {
      write("error", event, fields);
    }
  };
}

export const logger = createLogger();
