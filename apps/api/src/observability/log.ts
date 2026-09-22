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
 *   - never log a query's bound parameters. drizzle-orm wraps every failed statement in a
 *     `DrizzleQueryError` whose message is `Failed query: <sql>\nparams: <every bound value>`,
 *     and the bound values of an INSERT are the request (an email address, a session token, a
 *     push token). `errorFields` below is the one way an error reaches a log line, and it keeps
 *     the name, a message cut at the params marker and capped in length, a driver error code,
 *     and the stack FRAMES (never the message line the stack repeats). postgres.js errors carry
 *     `detail` ("Failing row contains (...)"), `query` and `parameters` too; none of those are
 *     copied. The Sentry scrubber applies the same cut to exception values.
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

/** The longest error message kept on a log line or a Sentry exception value. */
export const ERROR_MESSAGE_MAX_LENGTH = 200;

/** The marker drizzle-orm puts between the statement and its bound values. */
const QUERY_PARAMS_MARKER = '\nparams:';

/**
 * Cuts the bound parameters off a query error message. Everything from drizzle-orm's `params:`
 * marker on is request content and is dropped; a message without the marker is unchanged.
 */
export function stripQueryParams(message: string): string {
  const marker = message.indexOf(QUERY_PARAMS_MARKER);
  return marker === -1 ? message : message.slice(0, marker);
}

/** `stripQueryParams` plus the length cap: the only form an error message takes on a line. */
export function safeErrorMessage(message: string): string {
  const stripped = stripQueryParams(message);
  return stripped.length <= ERROR_MESSAGE_MAX_LENGTH
    ? stripped
    : `${stripped.slice(0, ERROR_MESSAGE_MAX_LENGTH)}...`;
}

/** A driver's error code (`23505`, `22021`, `ECONNREFUSED`), when the error carries one. */
function errorCode(error: object): string | null {
  const code: unknown = (error as { code?: unknown }).code;
  return typeof code === 'string' && code !== '' ? code : null;
}

/**
 * The stack frames only. `error.stack` starts with `${name}: ${message}`, which would put the
 * unsanitised message straight back on the line; the frames are the part worth keeping.
 */
function stackFrames(error: Error): string | null {
  const frames = (error.stack ?? '')
    .split('\n')
    .filter((line) => /^\s+at\s/.test(line))
    .join('\n');
  return frames === '' ? null : frames;
}

/**
 * Turns an unknown thrown value into loggable fields: the name, the sanitised message, the
 * driver code when there is one, the stack frames, and the same three for a `cause` (a
 * `DrizzleQueryError` wraps the postgres.js error that carries the useful code and message).
 * Nothing else on the error object is copied.
 */
export function errorFields(error: unknown): LogFields {
  if (!(error instanceof Error)) {
    return {
      error_name: 'unknown',
      error_message: safeErrorMessage(String(error)),
      error_stack: null,
    };
  }
  const fields: Record<string, unknown> = {
    error_name: error.name,
    error_message: safeErrorMessage(error.message),
    error_stack: stackFrames(error),
  };
  const code = errorCode(error);
  if (code !== null) {
    fields['error_code'] = code;
  }
  const cause: unknown = error.cause;
  if (cause instanceof Error) {
    fields['cause_name'] = cause.name;
    fields['cause_message'] = safeErrorMessage(cause.message);
    const causeCode = errorCode(cause);
    if (causeCode !== null) {
      fields['cause_code'] = causeCode;
    }
  }
  return fields;
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
