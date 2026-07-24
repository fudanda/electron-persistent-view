import { beforeEach, describe, expect, test, vi } from 'vitest'

const electronMock = vi.hoisted(() => {
  type Listener = () => void

  class MockWebContents {
    destroyed = false
    focused = false
    reloaded = false
    loadedUrls: string[] = []
    windowOpenHandler: ((details: { url: string }) => unknown) | null = null
    loadURL = vi.fn(async (url: string) => {
      this.loadedUrls.push(url)
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
      this.destroyed = true
    })
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
  }
  const pathSession = {
    clearStorageData: vi.fn(async () => undefined),
  }

  return {
    appReady: true,
    MockWebContentsView,
    partitionSession,
    pathSession,
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
          listeners.set(event, new Set([listener]))
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
      path: 'D:\\profiles\\account',
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
  })

  test('opens a secure view and attaches it to the parent', async () => {
    const configureWebContents = vi.fn()
    const controller = new PersistentViewController({
      session: electronMock.partitionSession as never,
      webPreferences: {
        devTools: true,
        nodeIntegration: true,
        webSecurity: false,
      } as never,
      backgroundColor: '#123456',
      borderRadius: 6,
      configureWebContents,
    })
    const parent = electronMock.createParentWindow()

    await controller.open({
      parentWindow: parent as never,
      url: 'https://example.test/',
      bounds: { x: 1.4, y: 2.6, width: 600.2, height: 400.8 },
    })

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
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    })
    expect(configureWebContents).toHaveBeenCalledOnce()
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

  test('validates bounds and delegates reload and storage clearing', async () => {
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
    expect(electronMock.partitionSession.clearStorageData).toHaveBeenCalledWith({
      origin: 'https://example.test',
    })
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
})
