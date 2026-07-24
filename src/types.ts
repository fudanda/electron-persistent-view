import type {
  BaseWindow,
  ClearStorageDataOptions,
  LoadURLOptions,
  Rectangle,
  Session,
  WebContents,
  WebPreferences,
} from 'electron'

export interface PartitionPersistentSessionConfig {
  type: 'partition'
  partition: `persist:${string}`
  cache?: boolean
}

export interface PathPersistentSessionConfig {
  type: 'path'
  path: string
  cache?: boolean
}

export type PersistentSessionConfig =
  | PartitionPersistentSessionConfig
  | PathPersistentSessionConfig

export type PersistentSessionInput = PersistentSessionConfig | Session

type EnforcedSecureWebPreferences = {
  session?: never
  partition?: never
  nodeIntegration?: false
  contextIsolation?: true
  sandbox?: true
  webSecurity?: true
}

export type PersistentViewWebPreferences = Omit<
  WebPreferences,
  keyof EnforcedSecureWebPreferences
> & EnforcedSecureWebPreferences

export interface PersistentViewContext {
  session: Session
  webContents: WebContents
}

export type PersistentViewCleanup = () => void

export interface PersistentViewControllerOptions {
  session: PersistentSessionInput
  webPreferences?: PersistentViewWebPreferences
  backgroundColor?: string
  borderRadius?: number
  configureWebContents?: (
    context: PersistentViewContext,
  ) => void | PersistentViewCleanup
}

export interface OpenPersistentViewOptions {
  parentWindow: BaseWindow
  url: string
  bounds: Rectangle
  visible?: boolean
  focus?: boolean
  loadOptions?: LoadURLOptions
}

export type PersistentViewState =
  | 'idle'
  | 'opening'
  | 'visible'
  | 'hidden'
  | 'closing'

export type {
  BaseWindow,
  ClearStorageDataOptions,
  LoadURLOptions,
  Rectangle,
  Session,
  WebContents,
}
