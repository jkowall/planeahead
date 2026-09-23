/**
 * The app entry (package.json `main`).
 *
 * `polyfillWebCrypto()` is the first statement: Expo SDK 57's runtime installs no global
 * `crypto`, and `uuidv7()` from @planeahead/shared (outbox keys, client-minted ids) throws
 * `MissingCryptoError` without `crypto.getRandomValues`. Imports are hoisted above statements, so
 * the router is loaded with `require` AFTER the polyfill has run, never with an `import`.
 */

import { polyfillWebCrypto } from 'expo-standard-web-crypto';

polyfillWebCrypto();

// eslint-disable-next-line @typescript-eslint/no-require-imports
require('expo-router/entry');
