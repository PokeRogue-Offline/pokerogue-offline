/**
 * Not imported anywhere - mobile-updater.ts talks to this plugin the same way
 * it already talks to the hand-registered OtaBridge plugin, through the raw
 * `Capacitor.Plugins.OtaUnzip` proxy Capacitor's native bridge exposes for
 * any registered plugin regardless of whether its JS-side wrapper is ever
 * imported (OtaBridge has no JS wrapper at all and works the same way).
 * Kept purely as documentation of the native method's contract.
 */
export interface OtaUnzipPlugin {
  /**
   * Unzips the archive at `sourcePath` into `destDir`, both absolute native
   * paths (or file:// URIs) - never Capacitor directory-alias-relative
   * strings, so this plugin needs no knowledge of Capacitor's Filesystem
   * directory semantics. Strips exactly one leading path segment from every
   * entry (this OTA zip's own `dist/` wrapper - see mobile-updater.ts) and
   * skips directory entries; `destDir`'s own root then directly contains
   * index.html. Streams every entry to disk in fixed-size chunks - never
   * holds a whole entry or the whole archive in memory at once.
   */
  unzip(options: { sourcePath: string; destDir: string }): Promise<{ entryCount: number }>;
}
