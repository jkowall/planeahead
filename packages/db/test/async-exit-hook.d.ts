/**
 * The two calls the test harness makes on `async-exit-hook` 2.0.1, which ships no types. Only
 * `test/embedded.ts` imports the module, to remove the `beforeExit` handler embedded-postgres
 * registers at import; nothing else may depend on this declaration.
 */
declare module 'async-exit-hook' {
  interface AsyncExitHook {
    (hook: (...args: unknown[]) => unknown): void;
    /** The process events currently hooked, `beforeExit` among them after the first hook. */
    hookedEvents(): string[];
    unhookEvent(event: string): void;
  }
  const asyncExitHook: AsyncExitHook;
  export default asyncExitHook;
}
