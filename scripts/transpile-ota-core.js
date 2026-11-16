#!/usr/bin/env node
/**
 * transpile-ota-core.js <input.ts> <output.cjs>
 *
 * Turns new-files/src/system/offline/ota-core.ts into a CommonJS module
 * the Electron main process can require(). The main process is plain
 * CommonJS with no build step of its own, while the same state machine is
 * compiled into the web bundle for mobile - this is what lets both use ONE
 * implementation instead of a hand-kept second copy.
 *
 * Uses TypeScript's own single-file transpile (types are simply erased; no
 * type-checking, no module resolution - ota-core.ts has no imports).
 * TypeScript is resolved from the current working directory first, so the
 * desktop workflows run this from inside pokerogue-src, whose devDependencies
 * already include it.
 */

const fs = require("fs");
const path = require("path");

function loadTypeScript() {
  try {
    return require(require.resolve("typescript", { paths: [process.cwd(), __dirname] }));
  } catch {
    console.error("ERROR: could not find the 'typescript' package from " + process.cwd());
    process.exit(1);
  }
}

function transpile(source, fileName, ts = loadTypeScript()) {
  const result = ts.transpileModule(source, {
    fileName,
    reportDiagnostics: true,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      removeComments: false,
    },
  });
  const errors = (result.diagnostics || []).filter(d => d.category === ts.DiagnosticCategory.Error);
  if (errors.length > 0) {
    throw new Error(errors.map(d => ts.flattenDiagnosticMessageText(d.messageText, "\n")).join("\n"));
  }
  return result.outputText;
}

function main() {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) {
    console.error(`Usage: node ${path.basename(__filename)} <input.ts> <output.cjs>`);
    process.exit(1);
  }
  const outputText = transpile(fs.readFileSync(input, "utf8"), path.basename(input));
  fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
  fs.writeFileSync(output, outputText);
  console.error(`[transpile-ota-core] wrote ${output} (${outputText.length} bytes)`);
}

if (require.main === module) {
  main();
}

module.exports = { transpile };
