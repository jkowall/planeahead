/**
 * The one validator every route uses (increment 8, ruling K9).
 *
 * `zValidator` without a hook answers a failure with `c.json(result, 400)`: the raw Zod
 * `safeParse` object, which is neither the PlaneAhead error envelope nor stable across Zod
 * versions, and whose type then flows into `AppType` as a response the mobile client would have
 * to model. The hook below answers 400 `validation_failed` with the issues flattened to
 * `{ path, message, code }` and the request id, and its return type is what `AppType` carries.
 *
 * Query values reach a validator as `string | string[]` (a repeated parameter is an array), so a
 * query schema must accept both: `queryValue()` takes a one-element array as its value and
 * refuses a repeated parameter with an issue rather than silently picking one of the values.
 */

import { zValidator } from '@hono/zod-validator';
import type { Context, TypedResponse, ValidationTargets } from 'hono';
import * as z from 'zod';
import type { ValidationFailedBody, ValidationIssue } from '@planeahead/shared';
import type { AppBindings } from '../env';

/** The envelope's type lives in `@planeahead/shared`, so the emitted client needs no Worker type. */
export type { ValidationFailedBody };

/** Zod issues as the envelope carries them: no input echo, no Zod internals. */
export function toValidationIssues(error: z.core.$ZodError): ValidationIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.map((segment) => (typeof segment === 'symbol' ? String(segment) : segment)),
    message: issue.message,
    code: issue.code,
  }));
}

/** The hook's answer: the envelope, typed, so `AppType` carries it as the 400 body. */
type ValidationFailedResponse = Response & TypedResponse<ValidationFailedBody, 400, 'json'>;

function envelopeHook(
  result: { readonly success: boolean; readonly error?: unknown; readonly target: string },
  c: Context<AppBindings>,
): ValidationFailedResponse | undefined {
  if (result.success) {
    return undefined;
  }
  return c.json<ValidationFailedBody, 400>(
    {
      error: 'validation_failed',
      message: `the request ${result.target} is invalid`,
      issues: toValidationIssues(result.error as z.core.$ZodError),
      requestId: c.var.requestId,
    },
    400,
  );
}

/**
 * `zValidator` with the envelope hook. Use it for every `json`, `query` and `param` target; a
 * bare `zValidator` import in a route is a review finding.
 */
export function validate<Target extends keyof ValidationTargets, Schema extends z.ZodType>(
  target: Target,
  schema: Schema,
) {
  return zValidator<Schema, Target, AppBindings, string, typeof envelopeHook>(
    target,
    schema,
    envelopeHook,
  );
}

/**
 * A query parameter: a string, or a one-element array of one (Hono hands a repeated parameter to
 * the validator as an array). A repeated parameter is refused.
 */
export function queryValue<Out>(schema: z.ZodType<Out, string>) {
  return z
    .union([z.string(), z.array(z.string())])
    .transform((value, ctx): string => {
      if (!Array.isArray(value)) {
        return value;
      }
      const [only] = value;
      if (value.length !== 1 || only === undefined) {
        ctx.addIssue({ code: 'custom', message: 'the parameter may appear only once' });
        return z.NEVER;
      }
      return only;
    })
    .pipe(schema);
}
