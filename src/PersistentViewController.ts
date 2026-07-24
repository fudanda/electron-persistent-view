import {
  type BaseWindow,
  type ClearStorageDataOptions,
  type Rectangle,
  type Session,
  type WebContents,
  WebContentsView,
} from 'electron'

import { resolvePersistentSession } from './session'
import type {
  OpenPersistentViewOptions,
  PersistentViewCleanup,
  PersistentViewControllerOptions,
  PersistentViewState,
} from './types'

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

export class PersistentViewController {
  readonly session: Session

  private managedView: ManagedView | null = null
  private operationId = 0
  private pendingLoadOperationId: number | null = null
  private desiredVisible = false
  private focusWhenVisible = false
  private currentState: PersistentViewState = 'idle'

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

  async open(options: OpenPersistentViewOptions): Promise<void> {
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

    const managedView = this.ensureView(options.parentWindow)
    const operationId = ++this.operationId
    const shouldShow = options.visible !== false
    this.pendingLoadOperationId = operationId
    this.desiredVisible = shouldShow
    this.focusWhenVisible = shouldShow && options.focus !== false

    try {
      const { view } = managedView
      view.setBounds(bounds)
      view.setVisible(false)
      this.currentState = 'opening'

      await view.webContents.loadURL(options.url, options.loadOptions)
      if (operationId !== this.operationId) return
      if (this.managedView !== managedView) return
      if (view.webContents.isDestroyed()) return

      this.pendingLoadOperationId = null
      if (!this.desiredVisible) {
        view.setVisible(false)
        this.currentState = 'hidden'
        return
      }

      view.setVisible(true)
      this.currentState = 'visible'
      if (this.focusWhenVisible) {
        view.webContents.focus()
      }
      this.focusWhenVisible = false
    } catch (error) {
      if (operationId !== this.operationId) return
      try {
        await this.close()
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'Persistent view failed to load and close cleanly',
        )
      }
      throw error
    } finally {
      if (this.pendingLoadOperationId === operationId) {
        this.pendingLoadOperationId = null
      }
    }
  }

  setBounds(bounds: Rectangle): boolean {
    const normalized = normalizeBounds(bounds)
    const view = this.managedView?.view
    if (!normalized || !view || view.webContents.isDestroyed()) {
      return false
    }
    view.setBounds(normalized)
    return true
  }

  show(options: { focus?: boolean } = {}): boolean {
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
    if (this.pendingLoadOperationId !== null) {
      view.setVisible(false)
      this.currentState = 'opening'
      return true
    }

    view.setVisible(true)
    this.currentState = 'visible'
    if (this.focusWhenVisible) {
      view.webContents.focus()
    }
    this.focusWhenVisible = false
    return true
  }

  hide(): boolean {
    const view = this.managedView?.view
    if (!view || view.webContents.isDestroyed()) return false

    this.desiredVisible = false
    this.focusWhenVisible = false
    view.setVisible(false)
    this.currentState = 'hidden'
    return true
  }

  reload(): boolean {
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

  async close(): Promise<void> {
    this.operationId += 1
    this.pendingLoadOperationId = null
    this.desiredVisible = false
    this.focusWhenVisible = false
    const managedView = this.managedView

    if (!managedView) {
      this.currentState = 'idle'
      return
    }

    this.currentState = 'closing'
    const cleanupError = this.disposeManagedView(managedView, true)
    this.currentState = 'idle'

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
      const cleanupError = this.disposeManagedView(existing, false)
      this.currentState = 'idle'
      if (cleanupError) {
        throw cleanupError
      }
    }

    const view = new WebContentsView({
      webPreferences: {
        ...this.options.webPreferences,
        session: this.session,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
      },
    })
    let configureCleanup: PersistentViewCleanup | null = null
    let attached = false
    let parentListenerAttached = false
    let destroyedListenerAttached = false
    let managedView: ManagedView | null = null

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
        this.operationId += 1
        this.pendingLoadOperationId = null
        this.desiredVisible = false
        this.focusWhenVisible = false
        this.currentState = 'closing'
        const cleanupError = this.disposeManagedView(managedView, false)
        this.currentState = 'idle'
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
}
