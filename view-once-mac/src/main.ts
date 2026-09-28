import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  shell,
  nativeTheme,
} from 'electron'
import path from 'path'
import os from 'os'
import fs from 'fs/promises'
import { WhatsAppController, SavedFileInfo, ConnectionStatus } from './whatsapp'

let mainWindow: BrowserWindow | null = null
let controller: WhatsAppController | null = null

const DEFAULT_SAVE_DIR = path.join(os.homedir(), 'Pictures', 'WhatsApp View Once')

function getAuthDir() {
  return path.join(app.getPath('userData'), 'wa-auth')
}

function getPrefsPath() {
  return path.join(app.getPath('userData'), 'prefs.json')
}

interface Prefs {
  saveDir: string
}

async function loadPrefs(): Promise<Prefs> {
  try {
    const raw = await fs.readFile(getPrefsPath(), 'utf8')
    const parsed = JSON.parse(raw) as Prefs
    if (parsed.saveDir) return parsed
  } catch {
    // default
  }
  return { saveDir: DEFAULT_SAVE_DIR }
}

async function savePrefs(prefs: Prefs) {
  await fs.mkdir(path.dirname(getPrefsPath()), { recursive: true })
  await fs.writeFile(getPrefsPath(), JSON.stringify(prefs, null, 2), 'utf8')
}

function send(channel: string, ...args: unknown[]) {
  mainWindow?.webContents.send(channel, ...args)
}

function createWindow() {
  nativeTheme.themeSource = 'dark'

  mainWindow = new BrowserWindow({
    width: 520,
    height: 720,
    minWidth: 420,
    minHeight: 560,
    title: 'View Once Saver',
    backgroundColor: '#0f1419',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  mainWindow.loadFile(path.join(__dirname, 'renderer.html'))

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

async function startWhatsApp(saveDir: string) {
  if (controller) {
    await controller.stop()
    controller = null
  }

  await fs.mkdir(saveDir, { recursive: true })

  controller = new WhatsAppController({
    authDir: getAuthDir(),
    saveDir,
    onStatus: (status: ConnectionStatus, detail?: string) => {
      send('status', { status, detail })
    },
    onQr: (dataUrl: string | null) => {
      send('qr', dataUrl)
    },
    onSaved: (info: SavedFileInfo) => {
      send('saved', info)
    },
    onError: (message: string) => {
      send('error', message)
    },
    onLog: (message: string) => {
      send('log', message)
    },
  })

  await controller.start()
}

function registerIpc() {
  ipcMain.handle('get-state', async () => {
    const prefs = await loadPrefs()
    return {
      saveDir: prefs.saveDir,
      defaultSaveDir: DEFAULT_SAVE_DIR,
    }
  })

  ipcMain.handle('choose-folder', async () => {
    const prefs = await loadPrefs()
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: 'Choose save folder',
      defaultPath: prefs.saveDir,
      properties: ['openDirectory', 'createDirectory'],
    })
    if (result.canceled || !result.filePaths[0]) return null

    const saveDir = result.filePaths[0]
    await savePrefs({ saveDir })
    if (controller) {
      await controller.setSaveDir(saveDir)
    }
    return saveDir
  })

  ipcMain.handle('reveal-folder', async () => {
    const prefs = await loadPrefs()
    await fs.mkdir(prefs.saveDir, { recursive: true })
    shell.openPath(prefs.saveDir)
  })

  ipcMain.handle('open-file', async (_event, filePath: string) => {
    if (typeof filePath === 'string' && filePath.length) {
      shell.showItemInFolder(filePath)
    }
  })

  ipcMain.handle('restart-whatsapp', async () => {
    const prefs = await loadPrefs()
    await startWhatsApp(prefs.saveDir)
  })
}

app.whenReady().then(async () => {
  registerIpc()
  createWindow()

  const prefs = await loadPrefs()
  await startWhatsApp(prefs.saveDir)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', async () => {
  await controller?.stop()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  void controller?.stop()
})
