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
  nodeIntegrationInWorker?: false
  nodeIntegrationInSubFrames?: false
  contextIsolation?: true
  sandbox?: true
  webSecurity?: true
  allowRunningInsecureContent?: false
  webviewTag?: false
  experimentalFeatures?: false
  enableBlinkFeatures?: never
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
  signal?: AbortSignal
  timeoutMs?: number
}

export const PersistentViewOpenStatus = {
  Opened: 'opened',
  Superseded: 'superseded',
  Closed: 'closed',
} as const

export type OpenPersistentViewResult =
  | { status: typeof PersistentViewOpenStatus.Opened }
  | { status: typeof PersistentViewOpenStatus.Superseded }
  | { status: typeof PersistentViewOpenStatus.Closed }

export type PersistentViewState =
  | 'idle'
  | 'opening'
  | 'visible'
  | 'hidden'
  | 'unresponsive'
  | 'crashed'
  | 'closing'

export type PersistentViewStateListener = (
  state: PersistentViewState,
) => void

export type {
  BaseWindow,
  ClearStorageDataOptions,
  LoadURLOptions,
  Rectangle,
  Session,
  WebContents,
}
