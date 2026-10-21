// design-sync entry barrel for clawmeets-frontend.  NOT app code.
//
// WHY IT EXISTS. The converter builds `window.ClawMeetsDS` from a package's
// shipped dist entry. This package has none (`"noEmit": true`; `build` is an
// app build), so the converter would synthesize `export * from '<every src
// file>'` - and `export *` does not re-export defaults. Almost every
// component here is a default export, so that entry would expose nothing and
// every preview would fail with "Element type is invalid".
//
// WHY IT LIVES HERE and not beside the rest of the sync inputs in the repo
// root's .design-sync/: the converter derives the package directory by
// walking UP from the entry to the first package.json with a name. The repo
// root has no package.json, so an entry outside this directory resolves the
// package to the wrong place and every package-relative config path breaks.
// Dot-prefixed so eslint and tsconfig's include both skip it.
//
// This is composition, not reimplementation: every line re-exports the
// repo's own component unchanged. It must stay in step with
// cfg.componentSrcMap - those pins are the sync's whole component list,
// because the list normally comes from a .d.ts tree this package lacks.

// common/ - default exports
export { default as Avatar } from './src/components/common/Avatar'
export { default as Badge } from './src/components/common/Badge'
export { default as BrandName } from './src/components/common/BrandName'
export { default as CollapsibleHeader } from './src/components/common/CollapsibleHeader'
export { default as ConnectionStatus } from './src/components/common/ConnectionStatus'
export { default as DropOverlay } from './src/components/common/DropOverlay'
export { default as InlineEditableTitle } from './src/components/common/InlineEditableTitle'
export { default as Loading } from './src/components/common/Loading'
export { default as Overlay } from './src/components/common/Overlay'
export { default as ResizeHandle } from './src/components/common/ResizeHandle'
export { default as TagAutocompleteInput } from './src/components/common/TagAutocompleteInput'
export { default as TagPillInput } from './src/components/common/TagPillInput'
export { default as Timestamp } from './src/components/common/Timestamp'
export { default as VerifiedBadge } from './src/components/common/VerifiedBadge'

// shared/ - default exports
export { default as ExpandToggle } from './src/components/shared/ExpandToggle'
export { default as MarkdownBody } from './src/components/shared/MarkdownBody'

// desk/ - default exports
export { default as DashTile } from './src/components/desk/DashTile'
export { default as DeskKeyConcepts } from './src/components/desk/DeskKeyConcepts'
export { default as DeskZeroState } from './src/components/desk/DeskZeroState'
export { default as LabelChip } from './src/components/desk/LabelChip'
export { default as SopItem } from './src/components/desk/SopItem'
export { default as TicketChip } from './src/components/desk/TicketChip'
export { default as TodoRowMenu } from './src/components/desk/TodoRowMenu'

// briefing/ - default exports
export { default as BriefingFrame } from './src/components/briefing/BriefingFrame'

// named exports (no default in source)
export { RenderBody } from './src/components/shared/RenderBody'
export { CardBand } from './src/components/desk/CardBand'
export { PhaseRail } from './src/components/desk/PhaseRail'
export { PlanBand } from './src/components/desk/PlanBand'

// Preview scaffolding, not a component: cfg.provider names it, and
// componentSrcMap excludes it from the synced component list.
export { DsProvider } from './.design-sync-provider'

// ── My Desk (the full page) and the handles a preview needs to seed it ──────
// DeskPage() takes NO props: it reads three Zustand stores and four react-query
// queries. Re-exporting those handles here is what lets a preview seed the SAME
// singletons the bundled components read — a preview that imports
// @tanstack/react-query directly gets a second copy whose context the bundle
// does not see. The non-component exports are excluded via componentSrcMap.
export { default as DeskPage } from './src/components/desk/DeskPage'
export { useAuthStore } from './src/stores/authStore'
export { useUIStore } from './src/stores/uiStore'
export { useDeskStore } from './src/stores/deskStore'
export { QueryClient, QueryClientProvider } from '@tanstack/react-query'
