/**
 * True for "Scooom dev" builds: ones produced with the GitHub Actions `dev`
 * workflow input set to `true` (nightly builds, and manually triggered dev-
 * flavor builds - see `.github/workflows/build-*.yml`'s "Inject Scooom
 * dev-build flag" step, which flips the `false` below to `true` via `sed`
 * right before `pnpm build`). Always `false` otherwise - a plain local
 * `pnpm build`/`pnpm build:app`, or a regular (non-dev) release build.
 *
 * Deliberately separate from upstream's own `isDev`
 * (src/constants/app-constants.ts, true only when
 * `import.meta.env.MODE === "development"`): every build this fork ships -
 * regular releases, the "-dev" OAuth/app-id flavor, and nightly - all run
 * `pnpm build --mode app`, so upstream's `isDev` is never true in anything
 * actually distributed. A dedicated flag here lets fork-only dev tooling
 * (e.g. prune-stale-pokemon-assets.js's diagnostic logging) gate on "is this
 * a Scooom dev build" without also flipping on any of upstream's own
 * isDev-gated behavior (debug menus, dexForDevs, AI overrides, etc.) that a
 * Scooom dev-flavor build was never meant to enable.
 */
export const isScoomDev = false;
