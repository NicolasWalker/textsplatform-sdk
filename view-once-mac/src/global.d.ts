import type { ViewOnceApi } from './preload'

declare global {
  interface Window {
    viewOnce: ViewOnceApi
  }
}

export {}
