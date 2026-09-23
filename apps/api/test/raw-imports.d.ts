/**
 * Vite's `?raw` suffix imports a file as a string. The provider tests use it to read the vendored
 * OpenAPI snapshots inside the Workers pool, where there is no `node:fs` onto the repository.
 */
declare module '*.yaml?raw' {
  const text: string;
  export default text;
}

/** A source file as text, for the static checks that read the code they guard. */
declare module '*.ts?raw' {
  const text: string;
  export default text;
}

/** wrangler.jsonc as text, for the check that its `secrets.required` blocks are complete. */
declare module '*.jsonc?raw' {
  const text: string;
  export default text;
}

/** package.json as text, for the check that the client export points at the emitted declaration. */
declare module '*.json?raw' {
  const text: string;
  export default text;
}
