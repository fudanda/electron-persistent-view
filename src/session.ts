import path from 'node:path'

import { app, session, type Session } from 'electron'

import type {
  PersistentSessionConfig,
  PersistentSessionInput,
} from './types'

const isPersistentSessionConfig = (
  input: PersistentSessionInput,
): input is PersistentSessionConfig => (
  typeof input === 'object'
  && input !== null
  && 'type' in input
  && (input.type === 'partition' || input.type === 'path')
)

export function resolvePersistentSession(
  input: PersistentSessionInput,
): Session {
  if (!isPersistentSessionConfig(input)) return input

  if (!app.isReady()) {
    throw new Error(
      'Electron app must be ready before resolving a persistent session',
    )
  }

  const options = typeof input.cache === 'boolean'
    ? { cache: input.cache }
    : undefined

  if (input.type === 'partition') {
    if (
      !input.partition.startsWith('persist:')
      || input.partition.length === 'persist:'.length
    ) {
      throw new Error(
        'Persistent session partition must start with "persist:" and include a name',
      )
    }
    return session.fromPartition(input.partition, options)
  }

  if (!input.path || !path.isAbsolute(input.path)) {
    throw new Error('Persistent session path must be an absolute path')
  }
  return session.fromPath(path.normalize(input.path), options)
}
