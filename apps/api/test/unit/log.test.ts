/**
 * `errorFields` is the one way a thrown error reaches a log line, so it is where a failed
 * statement's bound values (the request) must be cut off. The shapes below are the real ones:
 * drizzle-orm's `DrizzleQueryError` (message `Failed query: <sql>\nparams: <values>`, `query`
 * and `params` properties, the driver error as `cause`) and postgres.js's `PostgresError`
 * (`code`, `detail` with "Failing row contains (...)", `query`, `parameters`).
 */

import { DrizzleQueryError } from 'drizzle-orm/errors';
import { describe, expect, it } from 'vitest';
import {
  ERROR_MESSAGE_MAX_LENGTH,
  errorFields,
  safeErrorMessage,
  stripQueryParams,
} from '../../src/observability/log';

const MARKER = 'BODYMARKER_b6c1e0d4';
const TOKEN = 'SESSIONTOKEN_1f9a0b2c3d4e';

/** What postgres.js throws for a NUL byte, with the properties it attaches. */
function postgresError(): Error {
  const error = new Error('invalid byte sequence for encoding "UTF8": 0x00');
  error.name = 'PostgresError';
  Object.assign(error, {
    code: '22021',
    detail: `Failing row contains (1, ${MARKER}, ${TOKEN}).`,
    query: 'insert into "sessions" ("token") values ($1)',
    parameters: [TOKEN],
  });
  return error;
}

describe('stripQueryParams and safeErrorMessage', () => {
  it('cuts everything from the params marker on, and nothing otherwise', () => {
    expect(stripQueryParams(`Failed query: select $1\nparams: ${MARKER}`)).toBe(
      'Failed query: select $1',
    );
    expect(stripQueryParams('plain message')).toBe('plain message');
    expect(stripQueryParams(`first line\nparams: ${MARKER}\nmore`)).toBe('first line');
  });

  it('caps the length after the cut', () => {
    const long = 'x'.repeat(ERROR_MESSAGE_MAX_LENGTH + 50);
    expect(safeErrorMessage(long)).toHaveLength(ERROR_MESSAGE_MAX_LENGTH + 3);
    expect(safeErrorMessage(long).endsWith('...')).toBe(true);
    expect(safeErrorMessage('short')).toBe('short');
  });
});

describe('errorFields', () => {
  it('keeps name, sanitised message, codes and stack frames for a DrizzleQueryError', () => {
    const error = new DrizzleQueryError(
      'insert into "devices" ("model") values ($1)',
      [MARKER],
      postgresError(),
    );

    const fields = errorFields(error);
    const serialised = JSON.stringify(fields);

    expect(fields['error_message']).toBe(
      'Failed query: insert into "devices" ("model") values ($1)',
    );
    expect(fields['cause_name']).toBe('PostgresError');
    expect(fields['cause_code']).toBe('22021');
    expect(fields['cause_message']).toBe('invalid byte sequence for encoding "UTF8": 0x00');
    expect(serialised).not.toContain(MARKER);
    expect(serialised).not.toContain(TOKEN);
    expect(serialised).not.toContain('params:');
    expect(serialised).not.toContain('Failing row');
    // The stack keeps its frames and loses the message line that repeats the params.
    const stack = fields['error_stack'];
    expect(typeof stack === 'string' || stack === null).toBe(true);
    if (typeof stack === 'string') {
      expect(stack.split('\n').every((line) => /^\s+at\s/.test(line))).toBe(true);
    }
  });

  it('never copies query, params, parameters or detail off an error', () => {
    const fields = errorFields(postgresError());

    expect(Object.keys(fields).sort()).toEqual(
      ['error_code', 'error_message', 'error_name', 'error_stack'].sort(),
    );
    expect(fields['error_code']).toBe('22021');
    expect(JSON.stringify(fields)).not.toContain(MARKER);
  });

  it('truncates a long message and handles non-Error values', () => {
    const fields = errorFields(new Error('m'.repeat(1000)));
    expect((fields['error_message'] as string).length).toBe(ERROR_MESSAGE_MAX_LENGTH + 3);

    expect(errorFields('a string')).toEqual({
      error_name: 'unknown',
      error_message: 'a string',
      error_stack: null,
    });
    expect(errorFields(`x\nparams: ${MARKER}`)['error_message']).toBe('x');
  });
});
