import {
  type BaseWindow,
  type ClearStorageDataOptions,
  type Rectangle,
  type Session,
  type WebContents,
  type WebPreferences,
  WebContentsView,
} from 'electron'

import { resolvePersistentSession } from './session'
import type {
  OpenPersistentViewOptions,
  OpenPersistentViewResult,
  PersistentViewCleanup,
  PersistentViewControllerOptions,
  PersistentViewState,
  PersistentViewStateListener,
} from './types'
import { PersistentViewOpenStatus } from './types'

const normalizeBounds = (bounds: Rectangle): Rectangle | null => {
  const values = [bounds.x, bounds.y, bounds.width, bounds.height]
  if (!values.every(Number.isFinite)) return null

  const width = Math.round(bounds.width)
  const height = Math.round(bounds.height)
  if (width < 1 || height < 1) return null

  return {
    x: Math.max(0, Math.round(bounds.x)),
    y: Math.max(0, Math.round(bounds.y)),
    width,
    height,
  }
}

const combineErrors = (
  errors: unknown[],
  message: string,
): unknown | null => {
  if (errors.length === 0) return null
  if (errors.length === 1) return errors[0]
  return new AggregateError(errors, message)
}

interface ManagedView {
  view: WebContentsView
  parentWindow: BaseWindow
  configureCleanup: PersistentViewCleanup | null
  handleParentClosed: () => void
  handleWebContentsDestroyed: () => void
}

type OpenOutcome =
  | { kind: 'loaded' }
  | { kind: 'load-error'; error: unknown }
  | { kind: 'cancelled'; result: OpenPersistentViewResult }
  | { kind: 'cancel-error'; error: Error }

interface PendingOpen {
  cancellationResult: OpenPersistentViewResult | null
  resolveCancellation: (outcome: OpenOutcome) => void
  cleanup: () => void
}

const createAbortError = (reason: unknown): Error => {
  const error = reason === undefined
    ? new Error('Persistent view open was aborted')
    : new Error('Persistent view open was aborted', { cause: reason })
  error.name = 'AbortError'
  return error
}

const createTimeoutError = (timeoutMs: number): Error => {
  const error = new Error(
    `Persistent view load timed out after ${timeoutMs}ms`,
  )
  error.name = 'TimeoutError'
  return error
}

export class PersistentViewController {
  readonly session: Session

  private managedView: ManagedView | null = null
  private pendingOpen: PendingOpen | null = null
  private desiredVisible = false
  private focusWhenVisible = false
  private currentState: PersistentViewState = 'idle'
  private operationId = 0
  private isDisposing = false
  private isNotifyingState = false
  private readonly stateListeners = new Set<PersistentViewStateListener>()

  constructor(
    private readonly options: PersistentViewControllerOptions,
  ) {
    this.session = resolvePersistentSession(options.session)
  }

  get webContents(): WebContents | null {
    const webContents = this.managedView?.view.webContents
    return webContents && !webContents.isDestroyed() ? webContents : null
  }

  get state(): PersistentViewState {
    return this.currentState
  }

  async open(
    options: OpenPersistentViewOptions,
  ): Promise<OpenPersistentViewResult> {
    if (this.isDisposing || this.isNotifyingState) {
      return { status: PersistentViewOpenStatus.Closed }
    }

    const bounds = normalizeBounds(options.bounds)
    if (!bounds) {
      throw new Error('Persistent view bounds are invalid')
    }
    if (!options.url.trim()) {
      throw new Error('Persistent view URL is required')
    }
    if (options.parentWindow.isDestroyed()) {
      throw new Error('Persistent view parent window is unavailable')
    }
    if (
      options.timeoutMs !== undefined
      && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)
    ) {
      throw new Error('Persistent view timeout must be greater than zero')
    }
    if (options.signal?.aborted) {
      throw createAbortError(options.signal.reason)
    }

    const managedView = this.ensureView(options.parentWindow)
    this.cancelPendingOpen({
      status: PersistentViewOpenStatus.Superseded,
    })
    const operationId = ++this.operationId

    const shouldShow = options.visible !== false
    this.desiredVisible = shouldShow
    this.focusWhenVisible = shouldShow && options.focus !== false

    let resolveCancellation: (outcome: OpenOutcome) => void = () => {}
    const cancellationPromise = new Promise<OpenOutcome>(resolve => {
      resolveCancellation = resolve
    })
    let timeout: ReturnType<typeof setTimeout> | undefined
    const handleAbort = (): void => {
      resolveCancellation({
        kind: 'cancel-error',
        error: createAbortError(options.signal?.reason),
      })
    }
    const pendingOpen: PendingOpen = {
      cancellationResult: null,
      resolveCancellation,
      cleanup: () => {
        if (timeout !== undefined) {
          clearTimeout(timeout)
          timeout = undefined
        }
        options.signal?.removeEventListener('abort', handleAbort)
      },
    }
    this.pendingOpen = pendingOpen
    options.signal?.addEventListener('abort', handleAbort, { once: true })
    if (options.timeoutMs !== undefined) {
      timeout = setTimeout(() => {
        resolveCancellation({
          kind: 'cancel-error',
          error: createTimeoutError(options.timeoutMs as number),
        })
      }, options.timeoutMs)
    }

    const { view } = managedView
    try {
      view.setBounds(bounds)
      view.setVisible(false)
      this.setState('opening')

      let loadPromise: Promise<OpenOutcome>
      try {
        loadPromise = view.webContents
          .loadURL(options.url, options.loadOptions)
          .then(
            () => ({ kind: 'loaded' }) as const,
            error => ({ kind: 'load-error', error }) as const,
          )
      } catch (error) {
        loadPromise = Promise.resolve({ kind: 'load-error', error })
      }

      const outcome = await Promise.race([
        loadPromise,
        cancellationPromise,
      ])

      if (
        this.pendingOpen !== pendingOpen
        || this.operationId !== operationId
      ) {
        if (outcome.kind === 'cancel-error') {
          throw outcome.error
        }
        return pendingOpen.cancellationResult ?? {
          status: PersistentViewOpenStatus.Superseded,
        }
      }
      this.pendingOpen = null
      pendingOpen.cleanup()

      if (outcome.kind === 'cancelled') {
        return outcome.result
      }
      if (outcome.kind === 'cancel-error') {
        throw outcome.error
      }
      if (outcome.kind === 'load-error') {
        throw outcome.error
      }
      if (
        this.managedView !== managedView
        || view.webContents.isDestroyed()
      ) {
        return { status: PersistentViewOpenStatus.Closed }
      }

      if (!this.desiredVisible) {
        view.setVisible(false)
        this.setState('hidden')
        return this.getCompletedOpenResult(operationId, managedView)
      }

      view.setVisible(true)
      this.setState('visible')
      const completedResult = this.getCompletedOpenResult(
        operationId,
        managedView,
      )
      if (completedResult.status !== PersistentViewOpenStatus.Opened) {
        return completedResult
      }
      if (this.focusWhenVisible) {
        view.webContents.focus()
      }
      this.focusWhenVisible = false
      return this.getCompletedOpenResult(operationId, managedView)
    } catch (error) {
      if (
        this.operationId === operationId
        && this.managedView === managedView
      ) {
        await this.closeAfterFailedOpen(error)
      }
      throw error
    } finally {
      pendingOpen.cleanup()
      if (this.pendingOpen === pendingOpen) {
        this.pendingOpen = null
      }
    }
  }

  subscribe(listener: PersistentViewStateListener): () => void {
    this.stateListeners.add(listener)
    return () => {
      this.stateListeners.delete(listener)
    }
  }

  setBounds(bounds: Rectangle): boolean {
    if (this.isDisposing) return false
    const normalized = normalizeBounds(bounds)
    const view = this.managedView?.view
    if (!normalized || !view || view.webContents.isDestroyed()) {
      return false
    }
    view.setBounds(normalized)
    return true
  }

  show(options: { focus?: boolean } = {}): boolean {
    if (this.isDisposing) return false
    const managedView = this.managedView
    const view = managedView?.view
    if (
      !view
      || view.webContents.isDestroyed()
      || !managedView
      || managedView.parentWindow.isDestroyed()
    ) {
      return false
    }

    this.desiredVisible = true
    this.focusWhenVisible = options.focus === true
    if (this.pendingOpen !== null) {
      view.setVisible(false)
      this.setState('opening')
      return true
    }

    view.setVisible(true)
    this.setState('visible')
    if (this.focusWhenVisible) {
      view.webContents.focus()
    }
    this.focusWhenVisible = false
    return true
  }

  hide(): boolean {
    if (this.isDisposing) return false
    const view = this.managedView?.view
    if (!view || view.webContents.isDestroyed()) return false

    this.desiredVisible = false
    this.focusWhenVisible = false
    view.setVisible(false)
    this.setState('hidden')
    return true
  }

  reload(): boolean {
    if (this.isDisposing) return false
    const webContents = this.webContents
    if (!webContents) return false
    webContents.reload()
    return true
  }

  async clearStorageData(
    options?: ClearStorageDataOptions,
  ): Promise<void> {
    await this.session.clearStorageData(options)
  }

  flushStorageData(): void {
    this.session.flushStorageData()
  }

  async flushPersistentData(): Promise<void> {
    const flushErrors: unknown[] = []
    try {
      this.session.flushStorageData()
    } catch (error) {
      flushErrors.push(error)
    }
    try {
      await this.session.cookies.flushStore()
    } catch (error) {
      flushErrors.push(error)
    }

    const flushError = combineErrors(
      flushErrors,
      'Persistent view data failed to flush',
    )
    if (flushError) {
      throw flushError
    }
  }

  async close(): Promise<void> {
    if (this.isDisposing) return

    ++this.operationId
    this.cancelPendingOpen({
      status: PersistentViewOpenStatus.Closed,
    })
    this.desiredVisible = false
    this.focusWhenVisible = false
    const managedView = this.managedView

    if (!managedView) {
      this.setState('idle')
      return
    }

    this.isDisposing = true
    let cleanupError: unknown | null = null
    try {
      this.setState('closing')
      cleanupError = this.disposeManagedView(managedView, true)
    } finally {
      this.isDisposing = false
    }
    this.setState('idle')

    if (cleanupError) {
      throw cleanupError
    }
  }

  private ensureView(parentWindow: BaseWindow): ManagedView {
    const existing = this.managedView
    if (existing && !existing.view.webContents.isDestroyed()) {
      if (existing.parentWindow !== parentWindow) {
        throw new Error(
          'Persistent view cannot be attached to multiple windows',
        )
      }
      return existing
    }

    if (existing) {
      this.isDisposing = true
      let cleanupError: unknown | null = null
      try {
        cleanupError = this.disposeManagedView(existing, false)
      } finally {
        this.isDisposing = false
      }
      this.setState('idle')
      if (cleanupError) {
        throw cleanupError
      }
    }

    const webPreferences = {
      ...this.options.webPreferences,
    } as WebPreferences
    delete webPreferences.session
    delete webPreferences.partition
    delete webPreferences.nodeIntegration
    delete webPreferences.nodeIntegrationInWorker
    delete webPreferences.nodeIntegrationInSubFrames
    delete webPreferences.contextIsolation
    delete webPreferences.sandbox
    delete webPreferences.webSecurity
    delete webPreferences.allowRunningInsecureContent
    delete webPreferences.webviewTag
    delete webPreferences.experimentalFeatures
    delete webPreferences.enableBlinkFeatures

    const view = new WebContentsView({
      webPreferences: {
        ...webPreferences,
        session: this.session,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        nodeIntegrationInSubFrames: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        webviewTag: false,
        experimentalFeatures: false,
      },
    })
    let configureCleanup: PersistentViewCleanup | null = null
    let attached = false
    let parentListenerAttached = false
    let destroyedListenerAttached = false
    let managedView: ManagedView | null = null
    const wasDisposing = this.isDisposing
    this.isDisposing = true

    try {
      view.setBackgroundColor(this.options.backgroundColor ?? '#ffffff')
      view.setBorderRadius(this.options.borderRadius ?? 0)
      view.setVisible(false)
      view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

      configureCleanup = this.options.configureWebContents?.({
        session: this.session,
        webContents: view.webContents,
      }) ?? null

      const handleParentClosed = (): void => {
        if (this.managedView !== managedView) return
        void this.close().catch(error => {
          console.error(
            '[electron-persistent-view] failed to close after parent window closed',
            error,
          )
        })
      }
      const handleWebContentsDestroyed = (): void => {
        if (!managedView || this.managedView !== managedView) return
        ++this.operationId
        this.cancelPendingOpen({
          status: PersistentViewOpenStatus.Closed,
        })
        this.desiredVisible = false
        this.focusWhenVisible = false
        this.isDisposing = true
        let cleanupError: unknown | null = null
        try {
          this.setState('closing')
          cleanupError = this.disposeManagedView(managedView, false)
        } finally {
          this.isDisposing = false
        }
        this.setState('idle')
        if (cleanupError) {
          console.error(
            '[electron-persistent-view] cleanup failed after webContents was destroyed',
            cleanupError,
          )
        }
      }

      managedView = {
        view,
        parentWindow,
        configureCleanup,
        handleParentClosed,
        handleWebContentsDestroyed,
      }

      view.webContents.once('destroyed', handleWebContentsDestroyed)
      destroyedListenerAttached = true
      parentWindow.contentView.addChildView(view)
      attached = true
      parentWindow.once('closed', handleParentClosed)
      parentListenerAttached = true
      this.managedView = managedView
      return managedView
    } catch (error) {
      const rollbackErrors: unknown[] = [error]
      if (parentListenerAttached && managedView) {
        try {
          parentWindow.removeListener('closed', managedView.handleParentClosed)
        } catch (caughtError) {
          rollbackErrors.push(caughtError)
        }
      }
      if (
        destroyedListenerAttached
        && managedView
        && !view.webContents.isDestroyed()
      ) {
        try {
          view.webContents.removeListener(
            'destroyed',
            managedView.handleWebContentsDestroyed,
          )
        } catch (caughtError) {
          rollbackErrors.push(caughtError)
        }
      }

      try {
        configureCleanup?.()
      } catch (caughtError) {
        rollbackErrors.push(caughtError)
      }

      if (attached && !parentWindow.isDestroyed()) {
        try {
          parentWindow.contentView.removeChildView(view)
        } catch (caughtError) {
          rollbackErrors.push(caughtError)
        }
      }
      if (!view.webContents.isDestroyed()) {
        try {
          view.webContents.close({ waitForBeforeUnload: false })
        } catch (caughtError) {
          rollbackErrors.push(caughtError)
        }
      }

      throw combineErrors(
        rollbackErrors,
        'Persistent view setup and rollback failed',
      )
    } finally {
      this.isDisposing = wasDisposing
    }
  }

  private disposeManagedView(
    managedView: ManagedView,
    closeWebContents: boolean,
  ): unknown | null {
    const cleanupErrors: unknown[] = []
    if (this.managedView === managedView) {
      this.managedView = null
    }

    const {
      view,
      parentWindow,
      configureCleanup,
      handleParentClosed,
      handleWebContentsDestroyed,
    } = managedView

    try {
      parentWindow.removeListener('closed', handleParentClosed)
    } catch (error) {
      cleanupErrors.push(error)
    }
    if (!view.webContents.isDestroyed()) {
      try {
        view.webContents.removeListener(
          'destroyed',
          handleWebContentsDestroyed,
        )
      } catch (error) {
        cleanupErrors.push(error)
      }
    }

    try {
      configureCleanup?.()
    } catch (error) {
      cleanupErrors.push(error)
    }

    if (!parentWindow.isDestroyed()) {
      try {
        parentWindow.contentView.removeChildView(view)
      } catch (error) {
        cleanupErrors.push(error)
      }
    }

    if (closeWebContents && !view.webContents.isDestroyed()) {
      try {
        view.webContents.close({ waitForBeforeUnload: false })
      } catch (error) {
        cleanupErrors.push(error)
      }
    }
    return combineErrors(
      cleanupErrors,
      'Persistent view cleanup failed',
    )
  }

  private cancelPendingOpen(result: OpenPersistentViewResult): void {
    const pendingOpen = this.pendingOpen
    if (!pendingOpen) return

    this.pendingOpen = null
    pendingOpen.cancellationResult = result
    pendingOpen.cleanup()
    pendingOpen.resolveCancellation({ kind: 'cancelled', result })
  }

  private async closeAfterFailedOpen(error: unknown): Promise<never> {
    try {
      await this.close()
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Persistent view failed to open and close cleanly',
      )
    }
    throw error
  }

  private getCompletedOpenResult(
    operationId: number,
    managedView: ManagedView,
  ): OpenPersistentViewResult {
    if (
      this.operationId === operationId
      && this.managedView === managedView
      && !managedView.view.webContents.isDestroyed()
    ) {
      return { status: PersistentViewOpenStatus.Opened }
    }
    if (
      this.managedView === managedView
      && !managedView.view.webContents.isDestroyed()
    ) {
      return { status: PersistentViewOpenStatus.Superseded }
    }
    return { status: PersistentViewOpenStatus.Closed }
  }

  private setState(state: PersistentViewState): void {
    if (this.currentState === state) return
    this.currentState = state
    const wasNotifyingState = this.isNotifyingState
    this.isNotifyingState = true
    try {
      for (const listener of [...this.stateListeners]) {
        try {
          listener(state)
        } catch (error) {
          console.error(
            '[electron-persistent-view] state listener failed',
            error,
          )
        }
        if (this.currentState !== state) break
      }
    } finally {
      this.isNotifyingState = wasNotifyingState
    }
  }
}
