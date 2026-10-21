import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

function sharedLockDirectory(): string {
  let root = process.cwd();
  while (!existsSync(join(root, "pnpm-workspace.yaml"))) {
    const parent = dirname(root);
    if (parent === root) throw new Error("Workspace root unavailable; refusing to poll without a shared lock.");
    root = parent;
  }
  const directory = join(root, ".local", "telegram-poller-locks");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
}

// Shared by the production entry point and the temporary test runner.
// Fail closed after an unclean exit; never steal a potentially active lock.
export function acquirePollerLock(token: string, directory = sharedLockDirectory()): () => void {
  const path = join(directory, `briefline-poller-${createHash("sha256").update(token).digest("hex")}`);
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch {
    throw new Error("Polling lock unavailable. Another poller may be active, or an earlier process ended uncleanly. Do not start a second copy; inspect the stopped process before clearing its lock.");
  }
  let released = false;
  return () => {
    if (!released) {
      released = true;
      rmSync(path, { recursive: true, force: true });
    }
  };
}
