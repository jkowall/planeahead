/**
 * Every table in one module so `drizzle(client, { schema })` and drizzle-kit see the same set.
 * One file per domain; the plan's normative list names 70 tables across 8 domains.
 */
export * from './columns';
export * from './reference';
export * from './identity';
export * from './flights';
export * from './trips';
export * from './providers';
export * from './notifications';
export * from './imports';
export * from './billing';
