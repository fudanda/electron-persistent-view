'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const { app, BrowserWindow } = require('electron')

async function run() {
  const {
    PersistentViewController,
    resolvePersistentSession,
  } = require('../dist/index.cjs')

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'electron-persistent-view-'))
  const htmlPath = path.join(tempRoot, 'index.html')
  fs.writeFileSync(
    htmlPath,
    '<!doctype html><meta charset="utf-8"><title>smoke</title>',
    'utf8',
  )
  const pageUrl = pathToFileURL(htmlPath).toString()
  const parentWindow = new BrowserWindow({ show: false })

  const partitionSession = resolvePersistentSession({
    type: 'partition',
    partition: `persist:electron-persistent-view-smoke-${Date.now()}`,
  })
  const controller = new PersistentViewController({
    session: partitionSession,
  })
  await controller.open({
    parentWindow,
    url: pageUrl,
    bounds: { x: 0, y: 0, width: 480, height: 320 },
  })
  await controller.webContents.executeJavaScript(
    'localStorage.setItem("persistent-view-smoke", "ok")',
  )
  assert.equal(controller.hide(), true)
  assert.equal(controller.show(), true)
  await controller.close()

  const reopened = new PersistentViewController({
    session: partitionSession,
  })
  await reopened.open({
    parentWindow,
    url: pageUrl,
    bounds: { x: 0, y: 0, width: 480, height: 320 },
  })
  assert.equal(
    await reopened.webContents.executeJavaScript(
      'localStorage.getItem("persistent-view-smoke")',
    ),
    'ok',
  )
  await reopened.close()

  const pathSession = resolvePersistentSession({
    type: 'path',
    path: path.join(tempRoot, 'profile'),
  })
  assert.ok(pathSession)

  parentWindow.destroy()
  await partitionSession.clearStorageData()
  fs.rmSync(tempRoot, { recursive: true, force: true })
}

app.whenReady()
  .then(run)
  .then(() => {
    console.log('[electron-smoke] passed')
    app.quit()
  })
  .catch((error) => {
    console.error('[electron-smoke] failed', error)
    app.exit(1)
  })
