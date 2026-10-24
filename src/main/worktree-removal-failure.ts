import { isCheckoutRegistered, isUnregisteredRemovalLeftover } from './worktree-removal-leftover'
import type { WorktreeRemovalFailure, WorktreeRemovalRecord } from './worktree-removal-records'
import { worktreeCheckoutExists } from './worktree-removal-table'

/** Keep the error if Git dropped registration but left the checkout on disk. */
export async function failureLeftByGit(
  record: WorktreeRemovalRecord,
  error: unknown
): Promise<WorktreeRemovalFailure | undefined> {
  if (!(await isCheckoutLeftUnregistered(record))) {
    return undefined
  }
  const failure = {
    message: error instanceof Error ? error.message : String(error),
    failedAt: Date.now()
  }
  return failure
}

async function isCheckoutLeftUnregistered(record: WorktreeRemovalRecord): Promise<boolean> {
  if (!(await worktreeCheckoutExists(record.worktreePath))) {
    return false
  }
  try {
    return (
      !(await isCheckoutRegistered(record)) &&
      (await isUnregisteredRemovalLeftover(record.repoPath, record.worktreePath))
    )
  } catch (error) {
    console.warn(`[worktrees] could not list worktrees of ${record.repoPath}`, error)
    return false
  }
}
