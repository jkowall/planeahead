# @planeahead/mobile

Placeholder. This directory keeps the `apps/*` workspace glob valid until increment 9 creates the
Expo app in place with `create-expo-app` (Expo SDK 57, Expo Router, continuous native generation,
so `ios/` and `android/` are never committed).

Nothing here is installed, linted, typechecked or tested yet: there is no `package.json`, the root
`tsconfig.json` does not reference this directory, and `eslint.config.js` ignores `apps/mobile/**`.
Mobile tests run on Jest via `jest-expo`, not Vitest, so this app stays outside the Turborepo
`test` task until increment 9 wires it in.
