import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { failedWorktreeRemovals } from './worktree-removal-table'
import { withUnregisteredRemovalCheckouts } from './worktree-removal-listing'

const { runProcess } = vi.hoisted(() => ({ runProcess: vi.fn() }))
vi.mock('@orca/process-host', () => ({ runProcess }))

const originalPlatform = process.platform
const checkout = '/home/dev/feature'
const record = {
  worktreeId: 'repo-1::/home/dev/feature',
  repoId: 'repo-1',
  repoPath: '/home/dev/repo',
  worktreePath: checkout,
  branch: 'feature',
  head: 'abc',
  deleteBranch: true,
  force: false,
  requestedAt: 1,
  failure: { message: 'partial removal', failedAt: 2 }
}
const kinds = new Map<string, string>()
const files = new Map<string, string>()

beforeEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  failedWorktreeRemovals.set(record.worktreeId, record)
  runProcess.mockReset()
  kinds.clear()
  files.clear()
  runProcess.mockImplementation(async ({ args }: { args: string[] }) => {
    const command = args.at(-1) ?? ''
    const stat = /^LC_ALL=C stat -c %F -- '([^']+)'$/.exec(command)
    const read = /^cat -- '([^']+)'$/.exec(command)
    const value = stat ? kinds.get(stat[1]) : read ? files.get(read[1]) : undefined
    if (!stat && !read) {
      throw new Error(`Unexpected guest command: ${command}`)
    }
    return value === undefined
      ? {
          code: 1,
          stdout: '',
          stderr: 'stat: cannot stat: No such file or directory\n',
          timedOut: false
        }
      : { code: 0, stdout: `${value}\n`, stderr: '', timedOut: false }
  })
})

afterEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
  failedWorktreeRemovals.clear()
  vi.restoreAllMocks()
})

it('does not list an existing foreign WSL checkout as a missing removal leftover', async () => {
  kinds.set(checkout, 'directory')
  kinds.set(`${checkout}/.git`, 'directory')
  expect(await withUnregisteredRemovalCheckouts('repo-1', [], { wslDistro: 'Ubuntu' })).toEqual([])
  expect(failedWorktreeRemovals.has(record.worktreeId)).toBe(false)
})

it('keeps a proven WSL orphan whose Git link uses guest paths', async () => {
  kinds.set(checkout, 'directory')
  kinds.set(`${checkout}/.git`, 'regular file')
  kinds.set('/home/dev/repo/.git', 'directory')
  files.set(`${checkout}/.git`, 'gitdir: /home/dev/repo/.git/worktrees/feature')
  const rows = await withUnregisteredRemovalCheckouts('repo-1', [], { wslDistro: 'Ubuntu' })
  expect(rows).toMatchObject([{ path: checkout, removalError: 'partial removal' }])
  expect(failedWorktreeRemovals.has(record.worktreeId)).toBe(true)
  expect(runProcess).toHaveBeenCalled()
})

it('keeps pending cleanup when the WSL filesystem confirms the checkout is gone', async () => {
  const rows = await withUnregisteredRemovalCheckouts('repo-1', [], { wslDistro: 'Ubuntu' })
  expect(rows).toMatchObject([{ path: checkout, removalError: 'partial removal' }])
  expect(failedWorktreeRemovals.has(record.worktreeId)).toBe(true)
  expect(runProcess).toHaveBeenCalled()
})
