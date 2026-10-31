import { registerPlugin } from "@capacitor/core";

import type { OtaUnzipPlugin } from "./definitions";

/** Not imported anywhere - see definitions.ts's doc comment. Kept for parity with normal Capacitor plugin packages. */
const OtaUnzip = registerPlugin<OtaUnzipPlugin>("OtaUnzip");

export * from "./definitions";
export { OtaUnzip };
