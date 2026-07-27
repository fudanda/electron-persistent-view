'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const { app, BrowserWindow } = require('electron')

async function run() {
  const cjs = require('../dist/index.cjs')
  const esm = await import('../dist/index.mjs')
  const {
    PersistentViewController,
    resolvePersistentSession,
  } = cjs
  assert.equal(typeof esm.PersistentViewController, 'function')
  assert.equal(typeof esm.resolvePersistentSession, 'function')

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
  assert.deepEqual(await controller.open({
    parentWindow,
    url: pageUrl,
    bounds: { x: 0, y: 0, width: 480, height: 320 },
    visible: false,
  }), { status: 'opened' })
  assert.equal(controller.state, 'hidden')
  assert.equal(controller.show({ focus: true }), true)
  assert.equal(controller.state, 'visible')
  await controller.webContents.executeJavaScript(
    'localStorage.setItem("persistent-view-smoke", "ok")',
  )
  controller.flushStorageData()
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

  const pathSession = esm.resolvePersistentSession({
    type: 'path',
    path: path.join(tempRoot, 'profile'),
  })
  const pathController = new PersistentViewController({
    session: pathSession,
  })
  await pathController.open({
    parentWindow,
    url: pageUrl,
    bounds: { x: 0, y: 0, width: 480, height: 320 },
    visible: false,
  })
  assert.equal(pathController.state, 'hidden')
  await pathController.webContents.executeJavaScript(
    'localStorage.setItem("persistent-path-smoke", "ok")',
  )
  pathController.flushStorageData()
  await pathController.close()

  const reopenedPath = new PersistentViewController({
    session: pathSession,
  })
  await reopenedPath.open({
    parentWindow,
    url: pageUrl,
    bounds: { x: 0, y: 0, width: 480, height: 320 },
  })
  assert.equal(
    await reopenedPath.webContents.executeJavaScript(
      'localStorage.getItem("persistent-path-smoke")',
    ),
    'ok',
  )
  await reopenedPath.close()

  parentWindow.destroy()
  await partitionSession.clearStorageData()
  await pathSession.clearStorageData()
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
