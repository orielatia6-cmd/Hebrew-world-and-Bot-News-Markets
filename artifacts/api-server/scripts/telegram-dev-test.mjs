import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const directory = await mkdtemp(join(tmpdir(), "briefline-test-runner-"));
try {
  const entry = resolve(dirname(fileURLToPath(import.meta.url)), "../src/lib/briefing/dev-test.ts");
  const outfile = join(directory, "runner.mjs");
  await build({ entryPoints: [entry], outfile, bundle: true, platform: "node", format: "esm", logLevel: "silent" });
  const { runDevTest } = await import(pathToFileURL(outfile).href);
  await runDevTest();
} catch (error) {
  console.error(error instanceof Error ? error.message : "Temporary test failed.");
  process.exitCode = 1;
} finally {
  await rm(directory, { recursive: true, force: true });
}
