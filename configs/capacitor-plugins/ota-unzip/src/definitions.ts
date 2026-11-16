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
   * entry (the zip's own top-level wrapper directory - see
   * scripts/split-ota-bundle.js) and skips directory entries. Streams every
   * entry to disk in fixed-size chunks - never holds a whole entry or the
   * whole archive in memory at once.
   *
   * Truncation guard (the zip is deliberately not checksummed): when
   * `expectedBytes` is given the file's size is checked BEFORE unzipping,
   * and when `expectedEntries` is given the number of files extracted is
   * checked AFTER. Either mismatch rejects. Both come from the release's
   * OTA manifest.
   */
  unzip(options: { sourcePath: string; destDir: string; expectedBytes?: number; expectedEntries?: number }): Promise<{ entryCount: number }>;

  /**
   * Bytes available to the app on the volume holding its data. Used only
   * for a local "will this update fit" check before downloading.
   */
  freeSpace(): Promise<{ bytes: number }>;
}
