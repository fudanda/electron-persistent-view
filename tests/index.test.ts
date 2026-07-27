import path from 'node:path'

import { beforeEach, describe, expect, test, vi } from 'vitest'

const electronMock = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void

  const runtime: {
    loadURLHandler: (
      webContents: MockWebContents,
      url: string,
    ) => Promise<void> | null
  } = {
    loadURLHandler: () => null,
  }

  class MockWebContents {
    private readonly listeners = new Map<string, Set<Listener>>()
    destroyed = false
    focused = false
    reloaded = false
    loadedUrls: string[] = []
    windowOpenHandler: ((details: { url: string }) => unknown) | null = null
    loadURL = vi.fn(async (url: string) => {
      this.loadedUrls.push(url)
      await runtime.loadURLHandler(this, url)
    })
    focus = vi.fn(() => {
      this.focused = true
    })
    reload = vi.fn(() => {
      this.reloaded = true
    })
    setWindowOpenHandler = vi.fn((handler: (details: { url: string }) => unknown) => {
      this.windowOpenHandler = handler
    })
    isDestroyed = vi.fn(() => this.destroyed)
    close = vi.fn(() => {
      if (this.destroyed) return
      this.destroyed = true
      this.emit('destroyed')
    })
    once = vi.fn((event: string, listener: Listener) => {
      const wrapped: Listener = (...args) => {
        this.removeListener(event, wrapped)
        listener(...args)
      }
      const listeners = this.listeners.get(event) ?? new Set<Listener>()
      listeners.add(wrapped)
      this.listeners.set(event, listeners)
      return this
    })
    removeListener = vi.fn((event: string, listener: Listener) => {
      this.listeners.get(event)?.delete(listener)
      return this
    })
    emit(event: string, ...args: unknown[]) {
      for (const listener of [...(this.listeners.get(event) ?? [])]) {
        listener(...args)
      }
    }
    destroyExternally() {
      if (this.destroyed) return
      this.destroyed = true
      this.emit('destroyed')
    }
  }

  class MockWebContentsView {
    static instances: MockWebContentsView[] = []
    readonly webContents = new MockWebContents()
    readonly options: Record<string, unknown>
    bounds: Record<string, number> | null = null
    visible = true
    backgroundColor: string | null = null
    borderRadius: number | null = null

    constructor(options: Record<string, unknown>) {
      this.options = options
      MockWebContentsView.instances.push(this)
    }

    setBounds = vi.fn((bounds: Record<string, number>) => {
      this.bounds = bounds
    })
    setVisible = vi.fn((visible: boolean) => {
      this.visible = visible
    })
    setBackgroundColor = vi.fn((color: string) => {
      this.backgroundColor = color
    })
    setBorderRadius = vi.fn((radius: number) => {
      this.borderRadius = radius
    })
  }

  const partitionSession = {
    clearStorageData: vi.fn(async () => undefined),
    flushStorageData: vi.fn(),
  }
  const pathSession = {
    clearStorageData: vi.fn(async () => undefined),
    flushStorageData: vi.fn(),
  }

  return {
    appReady: true,
    MockWebContentsView,
    partitionSession,
    pathSession,
    runtime,
    fromPartition: vi.fn(() => partitionSession),
    fromPath: vi.fn(() => pathSession),
    createParentWindow() {
      const listeners = new Map<string, Set<Listener>>()
      const parent = {
        destroyed: false,
        contentView: {
          addChildView: vi.fn(),
          removeChildView: vi.fn(),
        },
        isDestroyed: vi.fn(() => parent.destroyed),
        once: vi.fn((event: string, listener: Listener) => {
          const eventListeners = listeners.get(event) ?? new Set<Listener>()
          eventListeners.add(listener)
          listeners.set(event, eventListeners)
          return parent
        }),
        removeListener: vi.fn((event: string, listener: Listener) => {
          listeners.get(event)?.delete(listener)
          return parent
        }),
        emit(event: string) {
          for (const listener of listeners.get(event) ?? []) listener()
          listeners.delete(event)
        },
      }
      return parent
    },
  }
})

vi.mock('electron', () => ({
  app: {
    isReady: () => electronMock.appReady,
  },
  session: {
    fromPartition: electronMock.fromPartition,
    fromPath: electronMock.fromPath,
  },
  WebContentsView: electronMock.MockWebContentsView,
}))

import {
  PersistentViewController,
  resolvePersistentSession,
} from '../src'

const createDeferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('resolvePersistentSession', () => {
  beforeEach(() => {
    electronMock.appReady = true
    electronMock.fromPartition.mockClear()
    electronMock.fromPath.mockClear()
  })

  test('resolves persistent partitions and forwards cache options', () => {
    expect(resolvePersistentSession({
      type: 'partition',
      partition: 'persist:account',
      cache: false,
    })).toBe(electronMock.partitionSession)
    expect(electronMock.fromPartition).toHaveBeenCalledWith(
      'persist:account',
      { cache: false },
    )
  })

  test('rejects non-persistent or unnamed partitions', () => {
    expect(() => resolvePersistentSession({
      type: 'partition',
      partition: 'memory' as `persist:${string}`,
    })).toThrow(/persist:/)
    expect(() => resolvePersistentSession({
      type: 'partition',
      partition: 'persist:',
    })).toThrow(/include a name/)
  })

  test('resolves only absolute paths', () => {
    expect(() => resolvePersistentSession({
      type: 'path',
      path: 'relative/profile',
    })).toThrow(/absolute/)

    expect(resolvePersistentSession({
      type: 'path',
      path: path.resolve('profiles', 'account'),
    })).toBe(electronMock.pathSession)
    expect(electronMock.fromPath).toHaveBeenCalled()
  })

  test('requires the Electron app to be ready', () => {
    electronMock.appReady = false
    expect(() => resolvePersistentSession({
      type: 'partition',
      partition: 'persist:account',
    })).toThrow(/must be ready/)
  })
})

describe('PersistentViewController', () => {
  beforeEach(() => {
    electronMock.appReady = true
    electronMock.MockWebContentsView.instances.length = 0
    electronMock.partitionSession.clearStorageData.mockClear()
    electronMock.partitionSession.flushStorageData.mockClear()
    electronMock.runtime.loadURLHandler = () => null
  })

  test('opens a secure view and attaches it to the parent', async () => {
    const configureWebContents = vi.fn()
    const controller = new PersistentViewController({
      session: electronMock.partitionSession as never,
      webPreferences: {
        devTools: true,
        nodeIntegration: true,
        nodeIntegrationInWorker: true,
        nodeIntegrationInSubFrames: true,
        webSecurity: false,
        allowRunningInsecureContent: true,
        webviewTag: true,
        experimentalFeatures: true,
        enableBlinkFeatures: 'UnsafeFeature',
      } as never,
      backgroundColor: '#123456',
      borderRadius: 6,
      configureWebContents,
    })
    const parent = electronMock.createParentWindow()

    await expect(controller.open({
      parentWindow: parent as never,
      url: 'https://example.test/',
      bounds: { x: 1.4, y: 2.6, width: 600.2, height: 400.8 },
    })).resolves.toEqual({ status: 'opened' })

    const view = electronMock.MockWebContentsView.instances[0]
    expect(parent.contentView.addChildView).toHaveBeenCalledWith(view)
    expect(view.bounds).toEqual({ x: 1, y: 3, width: 600, height: 401 })
    expect(view.visible).toBe(true)
    expect(view.backgroundColor).toBe('#123456')
    expect(view.borderRadius).toBe(6)
    expect(view.options.webPreferences).toMatchObject({
      session: electronMock.partitionSession,
      devTools: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      experimentalFeatures: false,
    })
    expect(view.options.webPreferences).not.toHaveProperty(
      'enableBlinkFeatures',
    )
    expect(configureWebContents).toHaveBeenCalledOnce()
    expect(controller.state).toBe('visible')
  })

  test('loads a view while keeping it hidden', async () => {
    const controller = new PersistentViewController({
      session: electronMock.partitionSession as never,
    })
    const parent = electronMock.createParentWindow()

    await controller.open({
      parentWindow: parent as never,
      url: 'https://example.test/hidden',
      bounds: { x: 0, y: 0, width: 400, height: 300 },
      visible: false,
      focus: true,
    })

    const view = electronMock.MockWebContentsView.instances[0]
    expect(view.visible).toBe(false)
    expect(view.webContents.focus).not.toHaveBeenCalled()
    expect(controller.state).toBe('hidden')
  })

  test('keeps the view hidden when hide is called during loading', async () => {
    const load = createDeferred()
    electronMock.runtime.loadURLHandler = () => load.promise
    const controller = new PersistentViewController({
      session: electronMock.partitionSession as never,
    })
    const parent = electronMock.createParentWindow()

    const opening = controller.open({
      parentWindow: parent as never,
      url: 'https://example.test/slow',
      bounds: { x: 0, y: 0, width: 400, height: 300 },
    })
    const view = electronMock.MockWebContentsView.instances[0]
    expect(controller.hide()).toBe(true)
    expect(view.visible).toBe(false)

    load.resolve(undefined)
    await opening
    expect(view.visible).toBe(false)
    expect(view.webContents.focus).not.toHaveBeenCalled()
    expect(controller.state).toBe('hidden')
  })

  test('waits for loading to finish before showing and focusing', async () => {
    const load = createDeferred()
    electronMock.runtime.loadURLHandler = () => load.promise
    const controller = new PersistentViewController({
      session: electronMock.partitionSession as never,
    })
    const parent = electronMock.createParentWindow()

    const opening = controller.open({
      parentWindow: parent as never,
      url: 'https://example.test/slow-hidden',
      bounds: { x: 0, y: 0, width: 400, height: 300 },
      visible: false,
    })
    const view = electronMock.MockWebContentsView.instances[0]
    expect(controller.show({ focus: true })).toBe(true)
    expect(view.visible).toBe(false)
    expect(view.webContents.focus).not.toHaveBeenCalled()
    expect(controller.state).toBe('opening')

    load.resolve(undefined)
    await opening
    expect(view.visible).toBe(true)
    expect(view.webContents.focus).toHaveBeenCalledOnce()
    expect(controller.state).toBe('visible')
  })

  test('uses the last open request when loads complete out of order', async () => {
    const firstLoad = createDeferred()
    const secondLoad = createDeferred()
    electronMock.runtime.loadURLHandler = (_webContents, url) => (
      url.endsWith('/first') ? firstLoad.promise : secondLoad.promise
    )
    const controller = new PersistentViewController({
      session: electronMock.partitionSession as never,
    })
    const parent = electronMock.createParentWindow()
    const sharedOptions = {
      parentWindow: parent as never,
      bounds: { x: 0, y: 0, width: 400, height: 300 },
    }

    const firstOpen = controller.open({
      ...sharedOptions,
      url: 'https://example.test/first',
    })
    const secondOpen = controller.open({
      ...sharedOptions,
      url: 'https://example.test/second',
      visible: false,
    })

    await expect(firstOpen).resolves.toEqual({ status: 'superseded' })
    secondLoad.resolve(undefined)
    await expect(secondOpen).resolves.toEqual({ status: 'opened' })
    expect(controller.state).toBe('hidden')

    firstLoad.resolve(undefined)
    expect(controller.state).toBe('hidden')
    expect(electronMock.MockWebContentsView.instances[0].visible).toBe(false)
  })

  test('does not let a stale load resurrect a closed view', async () => {
    const firstLoad = createDeferred()
    electronMock.runtime.loadURLHandler = (_webContents, url) => (
      url.endsWith('/first') ? firstLoad.promise : null
    )
    const controller = new PersistentViewController({
      session: electronMock.partitionSession as never,
    })
    const parent = electronMock.createParentWindow()
    const sharedOptions = {
      parentWindow: parent as never,
      bounds: { x: 0, y: 0, width: 400, height: 300 },
    }

    const firstOpen = controller.open({
      ...sharedOptions,
      url: 'https://example.test/first',
    })
    const firstView = electronMock.MockWebContentsView.instances[0]
    await controller.close()
    await expect(firstOpen).resolves.toEqual({ status: 'closed' })
    await controller.open({
      ...sharedOptions,
      url: 'https://example.test/second',
    })
    const secondView = electronMock.MockWebContentsView.instances[1]

    firstLoad.resolve(undefined)
    expect(firstView.webContents.close).toHaveBeenCalledOnce()
    expect(secondView.visible).toBe(true)
    expect(controller.webContents).toBe(secondView.webContents)
    expect(controller.state).toBe('visible')
  })

  test('hides and shows without reloading the page', async () => {
    const controller = new PersistentViewController({
      session: electronMock.partitionSession as never,
    })
    const parent = electronMock.createParentWindow()
    await controller.open({
      parentWindow: parent as never,
      url: 'https://example.test/',
      bounds: { x: 0, y: 0, width: 400, height: 300 },
    })
    const view = electronMock.MockWebContentsView.instances[0]

    expect(controller.hide()).toBe(true)
    expect(controller.state).toBe('hidden')
    expect(controller.show({ focus: true })).toBe(true)
    expect(controller.state).toBe('visible')
    expect(view.webContents.loadURL).toHaveBeenCalledOnce()
    expect(view.webContents.focus).toHaveBeenCalledTimes(2)
  })

  test('validates bounds and delegates reload and storage persistence', async () => {
    const controller = new PersistentViewController({
      session: electronMock.partitionSession as never,
    })
    const parent = electronMock.createParentWindow()
    await controller.open({
      parentWindow: parent as never,
      url: 'https://example.test/',
      bounds: { x: 0, y: 0, width: 400, height: 300 },
    })

    expect(controller.setBounds({
      x: Number.NaN,
      y: 0,
      width: 100,
      height: 100,
    })).toBe(false)
    expect(controller.reload()).toBe(true)
    await controller.clearStorageData({ origin: 'https://example.test' })
    controller.flushStorageData()
    expect(electronMock.partitionSession.clearStorageData).toHaveBeenCalledWith({
      origin: 'https://example.test',
    })
    expect(
      electronMock.partitionSession.flushStorageData,
    ).toHaveBeenCalledOnce()
  })

  test('aborts a pending open and closes the failed view', async () => {
    const load = createDeferred()
    electronMock.runtime.loadURLHandler = () => load.promise
    const controller = new PersistentViewController({
      session: electronMock.partitionSession as never,
    })
    const parent = electronMock.createParentWindow()
    const abortController = new AbortController()

    const opening = controller.open({
      parentWindow: parent as never,
      url: 'https://example.test/abort',
      bounds: { x: 0, y: 0, width: 400, height: 300 },
      signal: abortController.signal,
    })
    abortController.abort('cancelled by host')

    await expect(opening).rejects.toMatchObject({ name: 'AbortError' })
    expect(
      electronMock.MockWebContentsView.instances[0].webContents.close,
    ).toHaveBeenCalledOnce()
    expect(controller.webContents).toBeNull()
    expect(controller.state).toBe('idle')
    load.resolve(undefined)
  })

  test('preserves abort result when a replacement opens immediately', async () => {
    const abortedLoad = createDeferred()
    electronMock.runtime.loadURLHandler = (_webContents, url) => (
      url.endsWith('/aborted') ? abortedLoad.promise : null
    )
    const controller = new PersistentViewController({
      session: electronMock.partitionSession as never,
    })
    const parent = electronMock.createParentWindow()
    const abortController = new AbortController()
    const sharedOptions = {
      parentWindow: parent as never,
      bounds: { x: 0, y: 0, width: 400, height: 300 },
    }

    const abortedOpen = controller.open({
      ...sharedOptions,
      url: 'https://example.test/aborted',
      signal: abortController.signal,
    })
    abortController.abort()
    const replacementOpen = controller.open({
      ...sharedOptions,
      url: 'https://example.test/replacement',
    })

    await expect(abortedOpen).rejects.toMatchObject({ name: 'AbortError' })
    await expect(replacementOpen).resolves.toEqual({ status: 'opened' })
    expect(controller.state).toBe('visible')
    abortedLoad.resolve(undefined)
  })

  test('times out a pending open and can open again', async () => {
    const load = createDeferred()
    electronMock.runtime.loadURLHandler = () => load.promise
    const controller = new PersistentViewController({
      session: electronMock.partitionSession as never,
    })
    const parent = electronMock.createParentWindow()

    await expect(controller.open({
      parentWindow: parent as never,
      url: 'https://example.test/timeout',
      bounds: { x: 0, y: 0, width: 400, height: 300 },
      timeoutMs: 5,
    })).rejects.toMatchObject({ name: 'TimeoutError' })
    expect(controller.state).toBe('idle')

    electronMock.runtime.loadURLHandler = () => null
    await expect(controller.open({
      parentWindow: parent as never,
      url: 'https://example.test/recovered',
      bounds: { x: 0, y: 0, width: 400, height: 300 },
    })).resolves.toEqual({ status: 'opened' })
    load.resolve(undefined)
  })

  test('rejects invalid timeout and a signal already aborted', async () => {
    const controller = new PersistentViewController({
      session: electronMock.partitionSession as never,
    })
    const parent = electronMock.createParentWindow()
    const abortController = new AbortController()
    abortController.abort()
    const baseOptions = {
      parentWindow: parent as never,
      url: 'https://example.test/',
      bounds: { x: 0, y: 0, width: 400, height: 300 },
    }

    await expect(controller.open({
      ...baseOptions,
      timeoutMs: 0,
    })).rejects.toThrow(/greater than zero/)
    await expect(controller.open({
      ...baseOptions,
      signal: abortController.signal,
    })).rejects.toMatchObject({ name: 'AbortError' })
    expect(electronMock.MockWebContentsView.instances).toHaveLength(0)
  })

  test('subscribes to state changes without trusting listener code', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const states: string[] = []
    const controller = new PersistentViewController({
      session: electronMock.partitionSession as never,
    })
    const parent = electronMock.createParentWindow()
    const unsubscribe = controller.subscribe(state => {
      states.push(state)
    })
    controller.subscribe(() => {
      throw new Error('listener failed')
    })

    await controller.open({
      parentWindow: parent as never,
      url: 'https://example.test/',
      bounds: { x: 0, y: 0, width: 400, height: 300 },
      visible: false,
    })
    controller.show()
    await controller.close()
    unsubscribe()
    await controller.open({
      parentWindow: parent as never,
      url: 'https://example.test/reopened',
      bounds: { x: 0, y: 0, width: 400, height: 300 },
    })

    expect(states).toEqual([
      'opening',
      'hidden',
      'visible',
      'closing',
      'idle',
    ])
    expect(consoleError).toHaveBeenCalled()
    consoleError.mockRestore()
  })

  test('closes idempotently and can create a fresh view later', async () => {
    const cleanup = vi.fn()
    const controller = new PersistentViewController({
      session: electronMock.partitionSession as never,
      configureWebContents: () => cleanup,
    })
    const parent = electronMock.createParentWindow()
    const openOptions = {
      parentWindow: parent as never,
      url: 'https://example.test/',
      bounds: { x: 0, y: 0, width: 400, height: 300 },
    }
    await controller.open(openOptions)
    const firstView = electronMock.MockWebContentsView.instances[0]

    await controller.close()
    await controller.close()
    expect(firstView.webContents.close).toHaveBeenCalledOnce()
    expect(parent.contentView.removeChildView).toHaveBeenCalledOnce()
    expect(cleanup).toHaveBeenCalledOnce()
    expect(controller.state).toBe('idle')

    await controller.open(openOptions)
    expect(electronMock.MockWebContentsView.instances).toHaveLength(2)
  })

  test('allows a new open while an idempotent close is settling', async () => {
    const controller = new PersistentViewController({
      session: electronMock.partitionSession as never,
    })
    const parent = electronMock.createParentWindow()
    const openOptions = {
      parentWindow: parent as never,
      url: 'https://example.test/',
      bounds: { x: 0, y: 0, width: 400, height: 300 },
    }
    await controller.open(openOptions)

    const closing = controller.close()
    const reopening = controller.open({
      ...openOptions,
      url: 'https://example.test/reopened',
    })

    await expect(closing).resolves.toBeUndefined()
    await expect(reopening).resolves.toEqual({ status: 'opened' })
    expect(electronMock.MockWebContentsView.instances).toHaveLength(2)
    expect(controller.state).toBe('visible')
  })

  test('rolls back a view when configuration fails', async () => {
    const configureError = new Error('configure failed')
    const controller = new PersistentViewController({
      session: electronMock.partitionSession as never,
      configureWebContents: () => {
        throw configureError
      },
    })
    const parent = electronMock.createParentWindow()

    await expect(controller.open({
      parentWindow: parent as never,
      url: 'https://example.test/',
      bounds: { x: 0, y: 0, width: 400, height: 300 },
    })).rejects.toBe(configureError)

    const view = electronMock.MockWebContentsView.instances[0]
    expect(parent.contentView.addChildView).not.toHaveBeenCalled()
    expect(view.webContents.close).toHaveBeenCalledOnce()
    expect(controller.webContents).toBeNull()
    expect(controller.state).toBe('idle')
  })

  test('releases resources even when the cleanup hook fails', async () => {
    const cleanupError = new Error('cleanup failed')
    const cleanup = vi.fn(() => {
      throw cleanupError
    })
    const controller = new PersistentViewController({
      session: electronMock.partitionSession as never,
      configureWebContents: () => cleanup,
    })
    const parent = electronMock.createParentWindow()
    await controller.open({
      parentWindow: parent as never,
      url: 'https://example.test/',
      bounds: { x: 0, y: 0, width: 400, height: 300 },
    })
    const view = electronMock.MockWebContentsView.instances[0]

    await expect(controller.close()).rejects.toBe(cleanupError)
    expect(parent.contentView.removeChildView).toHaveBeenCalledWith(view)
    expect(view.webContents.close).toHaveBeenCalledOnce()
    expect(cleanup).toHaveBeenCalledOnce()
    expect(controller.webContents).toBeNull()
    expect(controller.state).toBe('idle')
    await expect(controller.close()).resolves.toBeUndefined()
  })

  test('cleans up when webContents is destroyed externally', async () => {
    const cleanup = vi.fn()
    const controller = new PersistentViewController({
      session: electronMock.partitionSession as never,
      configureWebContents: () => cleanup,
    })
    const parent = electronMock.createParentWindow()
    const openOptions = {
      parentWindow: parent as never,
      url: 'https://example.test/',
      bounds: { x: 0, y: 0, width: 400, height: 300 },
    }
    await controller.open(openOptions)
    const firstView = electronMock.MockWebContentsView.instances[0]

    firstView.webContents.destroyExternally()
    expect(cleanup).toHaveBeenCalledOnce()
    expect(parent.contentView.removeChildView).toHaveBeenCalledWith(firstView)
    expect(controller.webContents).toBeNull()
    expect(controller.state).toBe('idle')

    await controller.open(openOptions)
    expect(electronMock.MockWebContentsView.instances).toHaveLength(2)
    expect(controller.state).toBe('visible')
  })

  test('rejects a second parent without disturbing the active view', async () => {
    const controller = new PersistentViewController({
      session: electronMock.partitionSession as never,
    })
    const firstParent = electronMock.createParentWindow()
    const secondParent = electronMock.createParentWindow()
    await controller.open({
      parentWindow: firstParent as never,
      url: 'https://example.test/',
      bounds: { x: 0, y: 0, width: 400, height: 300 },
    })
    const view = electronMock.MockWebContentsView.instances[0]

    await expect(controller.open({
      parentWindow: secondParent as never,
      url: 'https://example.test/other',
      bounds: { x: 0, y: 0, width: 400, height: 300 },
    })).rejects.toThrow(/multiple windows/)

    expect(view.webContents.close).not.toHaveBeenCalled()
    expect(firstParent.contentView.removeChildView).not.toHaveBeenCalled()
    expect(controller.webContents).toBe(view.webContents)
    expect(controller.state).toBe('visible')
  })

  test('closes automatically when the parent window closes', async () => {
    const controller = new PersistentViewController({
      session: electronMock.partitionSession as never,
    })
    const parent = electronMock.createParentWindow()
    await controller.open({
      parentWindow: parent as never,
      url: 'https://example.test/',
      bounds: { x: 0, y: 0, width: 400, height: 300 },
    })
    const view = electronMock.MockWebContentsView.instances[0]

    parent.destroyed = true
    parent.emit('closed')
    await vi.waitFor(() => {
      expect(view.webContents.close).toHaveBeenCalledOnce()
    })
    expect(controller.state).toBe('idle')
  })

  test('settles a pending open when the parent window closes', async () => {
    const load = createDeferred()
    electronMock.runtime.loadURLHandler = () => load.promise
    const controller = new PersistentViewController({
      session: electronMock.partitionSession as never,
    })
    const parent = electronMock.createParentWindow()
    const opening = controller.open({
      parentWindow: parent as never,
      url: 'https://example.test/slow',
      bounds: { x: 0, y: 0, width: 400, height: 300 },
    })

    parent.destroyed = true
    parent.emit('closed')

    await expect(opening).resolves.toEqual({ status: 'closed' })
    expect(controller.state).toBe('idle')
    load.resolve(undefined)
  })
})
