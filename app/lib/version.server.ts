import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The commit this build came from.
 *
 * Read from a file the build writes, not from an environment variable set by
 * hand. A version pinned in /etc/growzar/growzar.env drifts the moment anyone
 * deploys without remembering to update it — and a health endpoint reporting a
 * commit that is not the one running is worse than one reporting nothing,
 * because it is believed.
 *
 * Resolved once: the file cannot change without a restart, since a restart is
 * what picks up a new build.
 */
function read(): string {
  try {
    return readFileSync(join(process.cwd(), "build", "version.txt"), "utf8").trim();
  } catch {
    // Dev, or a build made before this existed.
    return process.env.GROWZAR_VERSION ?? "dev";
  }
}

export const VERSION = read();
