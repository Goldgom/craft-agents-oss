import { createContext, useContext } from 'react'

export type StudioMode = 'agent' | 'canvas' | 'video' | 'super-agent'

export interface PageSidebarState {
  mode: StudioMode
  visible: boolean
  compact: boolean
  open: boolean
  setOpen: (open: boolean) => void
  toggle: () => void
}

const PageSidebarContext = createContext<PageSidebarState | null>(null)
export const PageSidebarProvider = PageSidebarContext.Provider
export const usePageSidebar = () => useContext(PageSidebarContext)
