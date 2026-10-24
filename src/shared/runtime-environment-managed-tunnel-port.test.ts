import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { encodePairingOffer } from './pairing'
import {
  addManagedOrcadEnvironment,
  refreshManagedOrcadPairing
} from './runtime-environment-managed-orcad-store'
import { resolveEnvironment } from './runtime-environment-store'
import { getPreferredPairingOffer, getRuntimeSshAccess } from './runtime-environments'
import { shippedBuildRewrite } from './runtime-environment-shipped-store.test-fixture'
import type * as StoreFile from './runtime-environment-store-file'
import type * as Sidecar from './runtime-environment-sidecar'
import { getRuntimeEnvironmentSidecarPath } from './runtime-environment-sidecar'
import { replaceManagedOrcadLocalPort } from './runtime-environment-managed-tunnel-port'

const failures = vi.hoisted(() => ({ store: false, sidecar: 0 }))
vi.mock('./runtime-environment-store-file', async (importOriginal) => {
  const actual = await importOriginal<typeof StoreFile>()
  return {
    ...actual,
    writeEnvironmentStore: (...args: Parameters<typeof actual.writeEnvironmentStore>) => {
      if (failures.store) {
        throw new Error('store write failed')
      }
      return actual.writeEnvironmentStore(...args)
    }
  }
})
vi.mock('./runtime-environment-sidecar', async (importOriginal) => {
  const actual = await importOriginal<typeof Sidecar>()
  return {
    ...actual,
    writeRuntimeEnvironmentSidecarEntry: (
      ...args: Parameters<typeof actual.writeRuntimeEnvironmentSidecarEntry>
    ) => {
      if (failures.sidecar > 0 && --failures.sidecar === 0) {
        throw new Error('sidecar write failed')
      }
      return actual.writeRuntimeEnvironmentSidecarEntry(...args)
    }
  }
})

let directory = ''
const code = (token = 'original-token') =>
  encodePairingOffer({
    v: 2,
    endpoint: 'ws://127.0.0.1:46768',
    deviceToken: token,
    publicKeyB64: Buffer.alloc(32, 1).toString('base64')
  })
function add() {
  return addManagedOrcadEnvironment(directory, {
    id: 'server',
    name: 'Builder',
    now: 100,
    pairingCode: code(),
    orcadDeployment: {
      sshTargetId: 'ssh-1',
      sshTargetGeneration: 7,
      localPort: 46768,
      remotePort: 6768
    }
  })
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-tunnel-port-'))
  failures.store = false
  failures.sidecar = 0
})
afterEach(() => rmSync(directory, { recursive: true, force: true }))

it('saves the endpoint and tunnel port without changing pairing or identity', () => {
  const original = add()
  const updated = replaceManagedOrcadLocalPort(directory, original, 41000)
  expect(getPreferredPairingOffer(updated)).toEqual({
    ...getPreferredPairingOffer(original),
    endpoint: 'ws://127.0.0.1:41000/'
  })
  expect(updated.id).toBe('server')
  expect(updated.pairingRevision ?? 0).toBeGreaterThan(
    original.pairingRevision ?? original.createdAt
  )
  expect(getRuntimeSshAccess(updated)).toEqual({
    sshTargetId: 'ssh-1',
    sshTargetGeneration: 7,
    localPort: 41000,
    remotePort: 6768
  })
  shippedBuildRewrite(directory, () => {})
  expect(getRuntimeSshAccess(resolveEnvironment(directory, 'server'))?.localPort).toBe(41000)
})

it('refuses to overwrite a pairing replaced during tunnel setup', () => {
  const original = add()
  refreshManagedOrcadPairing(directory, 'server', code('replacement-token'), 200)
  expect(() => replaceManagedOrcadLocalPort(directory, original, 41000)).toThrow(
    /changed|superseded/i
  )
  expect(getPreferredPairingOffer(resolveEnvironment(directory, 'server')).deviceToken).toBe(
    'replacement-token'
  )
  expect(getRuntimeSshAccess(resolveEnvironment(directory, 'server'))?.localPort).toBe(46768)
})

it('keeps the original link readable if the main store write fails', () => {
  const original = add()
  failures.store = true
  expect(() => replaceManagedOrcadLocalPort(directory, original, 41000)).toThrow(
    'store write failed'
  )
  expect(getRuntimeSshAccess(resolveEnvironment(directory, 'server'))?.localPort).toBe(46768)
  failures.store = false
  expect(
    getRuntimeSshAccess(replaceManagedOrcadLocalPort(directory, original, 41000))?.localPort
  ).toBe(41000)
})

it('reads the committed replacement if final sidecar cleanup is interrupted', () => {
  const original = add()
  failures.sidecar = 2
  expect(() => replaceManagedOrcadLocalPort(directory, original, 41000)).toThrow(
    'sidecar write failed'
  )
  const recovered = resolveEnvironment(directory, 'server')
  expect(getRuntimeSshAccess(recovered)?.localPort).toBe(41000)
  expect(getPreferredPairingOffer(recovered).endpoint).toBe('ws://127.0.0.1:41000/')
})

it('recovers an interrupted commit after an older sidecar writer drops unknown fields', () => {
  const original = add()
  failures.sidecar = 2
  expect(() => replaceManagedOrcadLocalPort(directory, original, 41000)).toThrow(
    'sidecar write failed'
  )
  const path = getRuntimeEnvironmentSidecarPath(directory)
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !('entries' in parsed) ||
    !parsed.entries ||
    typeof parsed.entries !== 'object' ||
    !('server' in parsed.entries)
  ) {
    throw new Error('missing sidecar entry')
  }
  const entry = parsed.entries.server
  if (
    !entry ||
    typeof entry !== 'object' ||
    !('binding' in entry) ||
    !('pendingBinding' in entry) ||
    !('orcadDeployment' in entry)
  ) {
    throw new Error('missing previous-build sidecar fields')
  }
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      entries: {
        server: {
          binding: entry.binding,
          pendingBinding: entry.pendingBinding,
          orcadDeployment: entry.orcadDeployment
        }
      }
    })
  )
  shippedBuildRewrite(directory, () => {})
  const recovered = resolveEnvironment(directory, 'server')
  expect(getRuntimeSshAccess(recovered)?.localPort).toBe(41000)
  expect(getPreferredPairingOffer(recovered).deviceToken).toBe('original-token')
})
