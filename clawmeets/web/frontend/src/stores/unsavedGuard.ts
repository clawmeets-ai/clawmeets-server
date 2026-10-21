import { create } from 'zustand'

interface UnsavedGuardState {
  isDirty: boolean
  message: string
  setDirty: (dirty: boolean, message?: string) => void
}

export const useUnsavedGuard = create<UnsavedGuardState>((set) => ({
  isDirty: false,
  message: 'Discard unsaved changes?',
  setDirty: (isDirty, message) =>
    set((state) => ({ isDirty, message: message ?? state.message })),
}))

// Synchronous check usable outside React render — returns true if the caller
// may proceed, false if the user chose to stay on the current page.
export function confirmLeaveIfDirty(): boolean {
  const state = useUnsavedGuard.getState()
  if (!state.isDirty) return true
  return window.confirm(state.message)
}
