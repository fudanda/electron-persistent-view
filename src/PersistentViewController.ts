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

export class PersistentViewController {
  readonly session: Session

  private view: WebContentsView | null = null
  private parentWindow: BaseWindow | null = null
  private configureCleanup: PersistentViewCleanup | null = null
  private operationId = 0
  private currentState: PersistentViewState = 'idle'

  constructor(
    private readonly options: PersistentViewControllerOptions,
  ) {
    this.session = resolvePersistentSession(options.session)
  }

  get webContents(): WebContents | null {
    if (!this.view || this.view.webContents.isDestroyed()) return null
    return this.view.webContents
  }

  get state(): PersistentViewState {
    return this.currentState
  }

  async open(options: OpenPersistentViewOptions): Promise<void> {
    const operationId = ++this.operationId
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

    try {
      const view = this.ensureView(options.parentWindow)
      view.setBounds(bounds)
      view.setVisible(false)
      this.currentState = 'opening'

      await view.webContents.loadURL(options.url, options.loadOptions)
      if (operationId !== this.operationId) return
      if (view.webContents.isDestroyed()) return

      view.setVisible(true)
      this.currentState = 'visible'
      if (options.focus !== false) {
        view.webContents.focus()
      }
    } catch (error) {
      if (operationId !== this.operationId) return
      await this.close()
      throw error
    }
  }

  setBounds(bounds: Rectangle): boolean {
    const normalized = normalizeBounds(bounds)
    if (!normalized || !this.view || this.view.webContents.isDestroyed()) {
      return false
    }
    this.view.setBounds(normalized)
    return true
  }

  show(options: { focus?: boolean } = {}): boolean {
    const view = this.view
    if (
      !view
      || view.webContents.isDestroyed()
      || !this.parentWindow
      || this.parentWindow.isDestroyed()
    ) {
      return false
    }

    view.setVisible(true)
    this.currentState = 'visible'
    if (options.focus === true) {
      view.webContents.focus()
    }
    return true
  }

  hide(): boolean {
    const view = this.view
    if (!view || view.webContents.isDestroyed()) return false

    this.operationId += 1
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
    const view = this.view
    const parentWindow = this.parentWindow
    this.view = null
    this.parentWindow = null

    if (!view) {
      this.currentState = 'idle'
      return
    }

    this.currentState = 'closing'
    parentWindow?.removeListener('closed', this.handleParentClosed)

    try {
      this.configureCleanup?.()
    } finally {
      this.configureCleanup = null
    }

    if (parentWindow && !parentWindow.isDestroyed()) {
      try {
        parentWindow.contentView.removeChildView(view)
      } catch {
        // The parent can detach its children while it is closing.
      }
    }

    if (!view.webContents.isDestroyed()) {
      view.webContents.close({ waitForBeforeUnload: false })
    }
    this.currentState = 'idle'
  }

  private readonly handleParentClosed = (): void => {
    void this.close()
  }

  private ensureView(parentWindow: BaseWindow): WebContentsView {
    if (this.view && !this.view.webContents.isDestroyed()) {
      if (this.parentWindow !== parentWindow) {
        throw new Error(
          'Persistent view cannot be attached to multiple windows',
        )
      }
      return this.view
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
    view.setBackgroundColor(this.options.backgroundColor ?? '#ffffff')
    view.setBorderRadius(this.options.borderRadius ?? 0)
    view.setVisible(false)
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

    const cleanup = this.options.configureWebContents?.({
      session: this.session,
      webContents: view.webContents,
    })

    this.view = view
    this.parentWindow = parentWindow
    this.configureCleanup = cleanup ?? null
    parentWindow.contentView.addChildView(view)
    parentWindow.once('closed', this.handleParentClosed)
    return view
  }
}
