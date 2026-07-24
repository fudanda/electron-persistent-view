# @fudanda/electron-persistent-view

A small main-process library for hosting a secure Electron `WebContentsView`
with persistent Chromium session data.

The package is independently implemented with Electron's public APIs. It does
not include authentication, renderer components, or navigation policy.

## Requirements

- Electron 40 or newer
- Call the API after `app.whenReady()`

## Install

```bash
npm install @fudanda/electron-persistent-view
```

## Persistent partition

```ts
import { BrowserWindow } from 'electron'
import {
  PersistentViewController,
  resolvePersistentSession,
} from '@fudanda/electron-persistent-view'

const session = resolvePersistentSession({
  type: 'partition',
  partition: 'persist:my-app-web',
})

const view = new PersistentViewController({
  session,
  webPreferences: {
    devTools: true,
  },
  configureWebContents: ({ webContents }) => {
    webContents.on('will-navigate', (_event, url) => {
      console.log('navigating to', url)
    })
  },
})

await view.open({
  parentWindow: BrowserWindow.getFocusedWindow()!,
  url: 'https://example.com',
  bounds: { x: 0, y: 0, width: 900, height: 700 },
})

view.hide() // Keeps the page and session alive.
view.show()
await view.close() // Closes the page; the persistent session remains.
```

## Persistent profile path

```ts
import { app } from 'electron'
import path from 'node:path'
import { resolvePersistentSession } from '@fudanda/electron-persistent-view'

const session = resolvePersistentSession({
  type: 'path',
  path: path.join(app.getPath('userData'), 'profiles', 'work'),
})
```

The path must be absolute. Partition sessions must use a non-empty `persist:`
name.

## Security defaults

Every view enforces:

- `nodeIntegration: false`
- `contextIsolation: true`
- `sandbox: true`
- `webSecurity: true`
- denied popup windows unless the host replaces the handler in
  `configureWebContents`

Host applications remain responsible for allowed origins, external links,
authentication, permissions, and storage-clearing policy.

## API

### `PersistentSessionConfig`

```ts
type PersistentSessionConfig =
  | {
      type: 'partition'
      partition: `persist:${string}`
      cache?: boolean
    }
  | {
      type: 'path'
      path: string
      cache?: boolean
    }
```

Partitions must start with `persist:` and include a name. Profile paths must be
absolute.

### `resolvePersistentSession(input)`

```ts
function resolvePersistentSession(
  input: PersistentSessionConfig | Session,
): Session
```

Resolve the Session once after `app.whenReady()` and pass the returned object
to every controller that should share cookies and storage. Passing an existing
Session returns that Session unchanged.

### `new PersistentViewController(options)`

```ts
interface PersistentViewControllerOptions {
  session: PersistentSessionConfig | Session
  webPreferences?: PersistentViewWebPreferences
  backgroundColor?: string
  borderRadius?: number
  configureWebContents?: (
    context: { session: Session; webContents: WebContents },
  ) => void | (() => void)
}
```

`webPreferences` may configure normal Electron preferences, but cannot supply
another session or weaken `nodeIntegration`, `contextIsolation`, `sandbox`, or
`webSecurity`. The optional hook runs once for each created WebContents and may
return an event-listener cleanup function.

### Controller methods

```ts
open(options: {
  parentWindow: BaseWindow
  url: string
  bounds: Rectangle
  focus?: boolean
  loadOptions?: LoadURLOptions
}): Promise<void>

show(options?: { focus?: boolean }): boolean
hide(): boolean
setBounds(bounds: Rectangle): boolean
reload(): boolean
close(): Promise<void>
clearStorageData(options?: ClearStorageDataOptions): Promise<void>
```

- `open()` creates or reuses the current view, attaches it, navigates, and
  displays it after loading.
- `hide()` cancels a pending show and keeps the page alive.
- `close()` detaches and closes WebContents without deleting persistent
  Session data. It is idempotent, and a later `open()` creates a fresh view.
- Boolean methods return `false` when there is no live view or the supplied
  bounds are invalid.

### Readonly properties

```ts
readonly session: Session
readonly webContents: WebContents | null
readonly state: 'idle' | 'opening' | 'visible' | 'hidden' | 'closing'
```

The controller supports one parent window at a time. `close()` is idempotent,
and the same controller can be opened again.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
npm run test:electron
npm pack --dry-run
```
