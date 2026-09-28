import { contextBridge, ipcRenderer } from 'electron'
import type { SavedFileInfo, ConnectionStatus } from './whatsapp'

export interface AppState {
  saveDir: string
  defaultSaveDir: string
}

const api = {
  getState: (): Promise<AppState> => ipcRenderer.invoke('get-state'),
  chooseFolder: (): Promise<string | null> => ipcRenderer.invoke('choose-folder'),
  revealFolder: (): Promise<void> => ipcRenderer.invoke('reveal-folder'),
  openFile: (filePath: string): Promise<void> => ipcRenderer.invoke('open-file', filePath),
  restartWhatsApp: (): Promise<void> => ipcRenderer.invoke('restart-whatsapp'),

  onStatus: (cb: (payload: { status: ConnectionStatus, detail?: string }) => void) => {
    const listener = (_: Electron.IpcRendererEvent, payload: { status: ConnectionStatus, detail?: string }) => cb(payload)
    ipcRenderer.on('status', listener)
    return () => ipcRenderer.removeListener('status', listener)
  },
  onQr: (cb: (dataUrl: string | null) => void) => {
    const listener = (_: Electron.IpcRendererEvent, dataUrl: string | null) => cb(dataUrl)
    ipcRenderer.on('qr', listener)
    return () => ipcRenderer.removeListener('qr', listener)
  },
  onSaved: (cb: (info: SavedFileInfo) => void) => {
    const listener = (_: Electron.IpcRendererEvent, info: SavedFileInfo) => cb(info)
    ipcRenderer.on('saved', listener)
    return () => ipcRenderer.removeListener('saved', listener)
  },
  onError: (cb: (message: string) => void) => {
    const listener = (_: Electron.IpcRendererEvent, message: string) => cb(message)
    ipcRenderer.on('error', listener)
    return () => ipcRenderer.removeListener('error', listener)
  },
  onLog: (cb: (message: string) => void) => {
    const listener = (_: Electron.IpcRendererEvent, message: string) => cb(message)
    ipcRenderer.on('log', listener)
    return () => ipcRenderer.removeListener('log', listener)
  },
}

contextBridge.exposeInMainWorld('viewOnce', api)

export type ViewOnceApi = typeof api
