/**
 * Shared contracts for PlaneAhead: Zod schemas with inferred types for everything that
 * crosses a boundary, the provider interfaces, the flight identity normaliser, the refresh
 * cadence with its SLO table, UUIDv7 and the cost table. Pure TypeScript: no I/O, no platform
 * API beyond `crypto.getRandomValues`, `Date` and `Intl.DateTimeFormat`. No default export.
 */

export const PLANEAHEAD = 'planeahead' as const;

export * from './airports';
export * from './cadence';
export * from './carriers';
export * from './cost';
export * from './flight-key';
export * from './flight-status';
export * from './ids';
export * from './live-activity';
export * from './providers';
export * from './rpc';
export * from './secrets';
export * from './sync';
