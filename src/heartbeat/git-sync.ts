import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { createLogger } from "../core/logger.js";

const log = createLogger("git-sync");
const execFile = promisify(execFileCb);

export interface PullResult {
  success: boolean;
  stashed: boolean;
  error?: string;
}

export interface PushResult {
  success: boolean;
  error?: string;
}

/**
 * Pull the latest changes for the workspace with stash-pull-pop pattern.
 *
 * Steps:
 * 1. Check if the working tree is dirty
 * 2. If dirty, stash changes with a heartbeat label
 * 3. Pull with --rebase
 * 4. Pop the stash if it was pushed
 *
 * On any failure, logs a warning and returns { success: false }.
 */
export async function pullWorkspace(
  workspaceDir: string,
  remote: string,
): Promise<PullResult> {
  let stashed = false;

  try {
    // Check if working tree is dirty
    const { stdout: statusOut } = await execFile("git", ["status", "--porcelain"], {
      cwd: workspaceDir,
    });

    const isDirty = statusOut.trim().length > 0;

    if (isDirty) {
      log.info({ workspaceDir }, "Dirty working tree before pull — stashing");
      await execFile("git", ["stash", "push", "-m", "heartbeat-auto-stash"], {
        cwd: workspaceDir,
      });
      stashed = true;
    }

    await execFile("git", ["pull", "--rebase", remote], {
      cwd: workspaceDir,
    });

    if (stashed) {
      await execFile("git", ["stash", "pop"], { cwd: workspaceDir });
      stashed = false; // successfully popped
    }

    log.info({ workspaceDir, remote }, "pullWorkspace succeeded");
    return { success: true, stashed: false };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.warn({ workspaceDir, remote, error, stashed }, "pullWorkspace failed");
    return { success: false, stashed, error };
  }
}

/**
 * Push local commits that are ahead of the remote tracking branch.
 *
 * Steps:
 * 1. Count commits ahead of upstream (@{u}..HEAD)
 * 2. If count > 0, push to the given remote
 * 3. If no upstream is configured, skip gracefully
 *
 * On any failure, logs a warning and returns { success: false }.
 */
export async function pushWorkspace(
  workspaceDir: string,
  remote: string,
): Promise<PushResult> {
  try {
    let aheadCount = 0;
    try {
      const { stdout } = await execFile(
        "git",
        ["rev-list", "--count", "@{u}..HEAD"],
        { cwd: workspaceDir },
      );
      aheadCount = parseInt(stdout.trim(), 10);
    } catch (upstreamErr) {
      // No upstream configured — skip push silently
      const msg = upstreamErr instanceof Error ? upstreamErr.message : String(upstreamErr);
      if (msg.includes("no upstream") || msg.includes("@{u}")) {
        log.debug({ workspaceDir }, "No upstream configured, skipping push");
        return { success: true };
      }
      throw upstreamErr;
    }

    if (aheadCount === 0) {
      log.debug({ workspaceDir }, "No local commits ahead of remote, skipping push");
      return { success: true };
    }

    log.info({ workspaceDir, remote, aheadCount }, "Pushing local commits");
    await execFile("git", ["push", remote], { cwd: workspaceDir });

    log.info({ workspaceDir, remote }, "pushWorkspace succeeded");
    return { success: true };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.warn({ workspaceDir, remote, error }, "pushWorkspace failed");
    return { success: false, error };
  }
}
