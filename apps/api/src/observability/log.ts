/**
 * Structured logging.
 *
 * One JSON object per line on stdout. Workers Logs indexes the fields, which is the whole point:
 * `console.log('something happened ' + id)` is not queryable and `console.log({...})` without a
 * level is not filterable. Retention is 7 days on the Paid plan, head sampling is 1 in staging
 * and 0.1 in production (wrangler.jsonc), and the included allowance is 20M events per month.
 *
 * Rules:
 *   - `event` is a stable snake_case identifier, never an interpolated sentence. Query on it.
 *   - every line carries the request id, so one request's work can be pulled out of a colo's
 *     interleaved output.
 *   - never log a secret, a token, an Authorization header, a cookie or a raw request body.
 *     Increment 5 adds a test that asserts no secret value reaches a log line.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogFields = Readonly<Record<string, unknown>>;

export interface LogLine extends LogFields {
  readonly level: LogLevel;
  readonly event: string;
}

/** Where a logger writes. Swapped in tests to capture lines instead of printing them. */
export type LogSink = (line: LogLine) => void;

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  /** A logger that adds `fields` to every line. Used to bind the request id once. */
  child(fields: LogFields): Logger;
}

export const consoleSink: LogSink = (line) => {
  // One call, one line. The Workers Logs pipeline treats a JSON string as a structured record.
  console.log(JSON.stringify(line));
};

/**
 * Turns an unknown thrown value into loggable fields. Keeps the message and the name, drops the
 * stack in production-sized lines but keeps it here because Workers Logs charges per event, not
 * per byte, and a stack is the difference between a useful and a useless error line.
 */
export function errorFields(error: unknown): LogFields {
  if (error instanceof Error) {
    return {
      error_name: error.name,
      error_message: error.message,
      error_stack: error.stack ?? null,
    };
  }
  return { error_name: 'unknown', error_message: String(error), error_stack: null };
}

export function createLogger(base: LogFields = {}, sink: LogSink = consoleSink): Logger {
  const emit = (level: LogLevel, event: string, fields?: LogFields): void => {
    sink({ ...base, ...fields, level, event });
  };
  return {
    debug: (event, fields) => {
      emit('debug', event, fields);
    },
    info: (event, fields) => {
      emit('info', event, fields);
    },
    warn: (event, fields) => {
      emit('warn', event, fields);
    },
    error: (event, fields) => {
      emit('error', event, fields);
    },
    child: (fields) => createLogger({ ...base, ...fields }, sink),
  };
}
