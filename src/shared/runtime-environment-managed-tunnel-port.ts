import {
  getOrcadSshDeployment,
  getPreferredPairingOffer,
  getRuntimeSshAccess,
  KnownRuntimeEnvironmentSchema,
  PersistedRuntimeEnvironmentSchema,
  type KnownRuntimeEnvironment
} from './runtime-environments'
import { resolveEnvironmentFromStore } from './runtime-environment-store'
import {
  readEnvironmentStore,
  readPersistedEnvironmentStore,
  writeEnvironmentStore,
  RuntimeEnvironmentStoreError
} from './runtime-environment-store-file'
import {
  readCurrentRuntimeEnvironmentSidecarEntry,
  writeRuntimeEnvironmentSidecarEntry
} from './runtime-environment-sidecar'

export function withRuntimeSshTunnelLocalPort(
  environment: KnownRuntimeEnvironment,
  localPort: number
): KnownRuntimeEnvironment {
  const link = getRuntimeSshAccess(environment)
  if (!link) {
    throw new Error('This server has no SSH tunnel.')
  }
  if (link.localPort === localPort) {
    return environment
  }
  return KnownRuntimeEnvironmentSchema.parse({
    ...environment,
    endpoints: environment.endpoints.map((endpoint) => {
      if (endpoint.id !== environment.preferredEndpointId) {
        return endpoint
      }
      const url = new URL(endpoint.endpoint)
      url.port = String(localPort)
      return { ...endpoint, endpoint: url.toString() }
    }),
    ...(environment.sshAccess ? { sshAccess: { ...environment.sshAccess, localPort } } : {}),
    ...(getOrcadSshDeployment(environment)
      ? { orcadDeployment: { ...getOrcadSshDeployment(environment), localPort } }
      : {})
  })
}

export function replaceManagedOrcadLocalPort(
  userDataPath: string,
  expected: KnownRuntimeEnvironment,
  localPort: number
): KnownRuntimeEnvironment {
  const current = resolveEnvironmentFromStore(readEnvironmentStore(userDataPath), expected.id)
  const deployment = getOrcadSshDeployment(current)
  const ownership = (environment: KnownRuntimeEnvironment) =>
    JSON.stringify([
      environment.createdAt,
      environment.pairingRevision ?? environment.createdAt,
      getOrcadSshDeployment(environment),
      environment.preferredEndpointId,
      getPreferredPairingOffer(environment)
    ])
  if (!deployment || ownership(current) !== ownership(expected)) {
    throw new RuntimeEnvironmentStoreError(
      'invalid_argument',
      'The managed tunnel changed during port recovery.'
    )
  }
  const candidate = withRuntimeSshTunnelLocalPort(current, localPort)
  const store = readPersistedEnvironmentStore(userDataPath)
  const existing = resolveEnvironmentFromStore(store, current.id)
  const entry = readCurrentRuntimeEnvironmentSidecarEntry(userDataPath, existing)
  if (!entry?.orcadDeployment) {
    throw new RuntimeEnvironmentStoreError(
      'invalid_argument',
      'The managed tunnel has no saved deployment link.'
    )
  }
  const now = Date.now()
  const next = PersistedRuntimeEnvironmentSchema.parse({
    ...candidate,
    updatedAt: now,
    pairingRevision: Math.max(now, (current.pairingRevision ?? current.createdAt) + 1)
  })
  const environments = store.environments.map((environment) =>
    environment.id === current.id ? next : environment
  )
  const { binding: _binding, ...state } = entry
  const updatedDeployment = { ...deployment, localPort }
  // Keep both tunnel bindings readable if a crash interrupts the two-file update.
  writeRuntimeEnvironmentSidecarEntry(userDataPath, store.environments, existing, state, next)
  writeEnvironmentStore(userDataPath, { version: 1, environments })
  writeRuntimeEnvironmentSidecarEntry(userDataPath, environments, next, {
    ...state,
    orcadDeployment: updatedDeployment
  })
  return resolveEnvironmentFromStore(readEnvironmentStore(userDataPath), current.id)
}
