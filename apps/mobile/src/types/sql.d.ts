/** drizzle-kit's migrations.js imports each migration; babel.config.js inlines it as a string. */
declare module '*.sql' {
  const source: string;
  export default source;
}
