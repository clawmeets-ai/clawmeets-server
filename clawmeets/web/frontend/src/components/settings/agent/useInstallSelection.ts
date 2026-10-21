import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'

/**
 * Optimistic mirror for an install/uninstall catalog (skills, MCP servers,
 * knowledge packs). `selection` reflects a click immediately; the diff against
 * the previous selection fires one install or uninstall, then `queryKey` is
 * invalidated so the server's list re-seeds the mirror.
 */
export function useInstallSelection({
  queryKey,
  installed,
  install,
  uninstall,
}: {
  queryKey: unknown[]
  installed: string[]
  install: (name: string) => Promise<unknown>
  uninstall: (name: string) => Promise<unknown>
}): { selection: string[]; onChange: (next: string[]) => void } {
  const queryClient = useQueryClient()
  const [selection, setSelection] = useState<string[]>([])
  useEffect(() => setSelection(installed), [installed])

  const onSuccess = () => queryClient.invalidateQueries({ queryKey })
  const installMutation = useMutation({ mutationFn: install, onSuccess })
  const uninstallMutation = useMutation({ mutationFn: uninstall, onSuccess })

  const onChange = (next: string[]) => {
    const added = next.find((s) => !selection.includes(s))
    const removed = selection.find((s) => !next.includes(s))
    setSelection(next)
    if (added) installMutation.mutate(added)
    if (removed) uninstallMutation.mutate(removed)
  }

  return { selection, onChange }
}
