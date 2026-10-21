import { useEffect, useRef, useState } from 'react'
import { lib } from '../today/lib'

// Shared compile-and-mount surface for the self-serve tab publishing
// protocol. The agent supplies `renderCodeJs` (the BODY of
// `function(mount, data, lib)`) plus opaque `data`; we compile via
// `new Function` and invoke against a freshly-cleared mount div.
//
// Used by:
//   - My Desk's briefing overlay (per brief tab)
//   - ProjectView's Report tab (the per-project completion report)
//
// The `lib` namespace stays imported from `../today/lib` so both
// surfaces see the same helpers, design tokens, and Chart.js setup —
// a single source of truth means agents can write one rendering
// vocabulary and have it work in either context.
//
// `runKey` should change whenever the underlying artifact's content
// changes (e.g. `${slug}::${generated_at}`) — that's the gate for
// re-running the compiled body. Inside the lifetime of one runKey we
// compile + execute exactly once; React re-renders are cheap.

type CompiledRenderer = (
  mount: HTMLElement,
  data: unknown,
  lib: typeof import('../today/lib').lib,
) => void

function compileRenderCode(
  code: string,
): CompiledRenderer | { __error: string } {
  try {
    // The trailing `root` param is intentional and never bound at call
    // time — it shadows `window.root`, which the browser auto-exposes
    // because index.html has `<div id="root">` (the React app mount).
    // Without this shadow, render bodies that mistakenly write
    // `root.appendChild(...)` instead of `mount.appendChild(...)` would
    // silently corrupt the React mount; with it, the bare reference
    // resolves to `undefined` so the try/catch below surfaces a clean
    // `Render error: …` inside the tab pane.
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    return new Function('mount', 'data', 'lib', 'root', code) as CompiledRenderer
  } catch (e) {
    return { __error: (e as Error).message }
  }
}

export function RenderBody({
  renderCodeJs,
  data,
  runKey,
  active = true,
}: {
  renderCodeJs: string
  data: unknown
  runKey: string
  active?: boolean
}) {
  const mountRef = useRef<HTMLDivElement | null>(null)
  const [error, setError] = useState<string | null>(null)
  const lastRunKey = useRef<string | null>(null)

  useEffect(() => {
    if (!active) return
    const mount = mountRef.current
    if (!mount) return
    if (lastRunKey.current === runKey) return
    lastRunKey.current = runKey

    setError(null)
    mount.innerHTML = ''
    const compiled = compileRenderCode(renderCodeJs)
    if (typeof compiled !== 'function') {
      setError(`Compile error: ${compiled.__error}`)
      return
    }
    try {
      compiled(mount, data, lib)
    } catch (e) {
      setError(`Render error: ${(e as Error).message}`)
    }
  }, [active, runKey, renderCodeJs, data])

  return (
    <>
      {error ? <div className="today-err">{error}</div> : null}
      <div ref={mountRef} />
    </>
  )
}
