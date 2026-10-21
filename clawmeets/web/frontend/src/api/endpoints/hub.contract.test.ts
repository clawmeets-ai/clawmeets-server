import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EPOCH_FIELDS, HUB_MODEL_KEYS, OPTIONALITY_EXCEPTIONS, UNMIRRORED_MODELS } from './hub.keys'

/**
 * The hub types against the FROZEN browser contract. The snapshot is written by
 * `tests/server/test_hub_browser_contract.py` from `server/hub/browser.py`; this
 * file only reads it. A field added, removed, made optional or made nullable on
 * either side fails here (the TypeScript side is held to hub.keys.ts by tsc).
 *
 * The path is relative to the repo root, which CI always checks out whole. A
 * sparse checkout fails loudly here rather than skipping.
 */

const FRONTEND = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const SNAPSHOT = join(FRONTEND, '..', '..', '..', 'tests', 'server', 'hub_contract_snapshot.json')

interface SnapshotModel {
  fields: Record<string, unknown>
  required: string[]
}
const snapshot = JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as Record<string, SnapshotModel>

/** browser.py `_AbsentWhenNone.ABSENT_WHEN_NONE`: nullable in the schema, but
 *  None is left OUT of the JSON, so the browser never sees null. */
const ABSENT_WHEN_NONE = new Set(['current_fingerprint'])

const sorted = (xs: readonly string[]) => [...xs].sort()
const isNullable = (schema: unknown) =>
  Array.isArray(schema) && schema.some((s) => typeof s === 'object' && s !== null && (s as { type?: string }).type === 'null')

describe('hub types match the frozen browser contract', () => {
  for (const [name, ts] of Object.entries(HUB_MODEL_KEYS)) {
    describe(name, () => {
      const snap = snapshot[name]

      it('exists in the snapshot', () => {
        expect(snap, `${name} is not in the snapshot`).toBeDefined()
      })

      it('has exactly the snapshot keys', () => {
        expect(sorted(ts.keys)).toEqual(sorted(Object.keys(snap.fields)))
      })

      it('has the snapshot optionality', () => {
        const snapOptional = Object.keys(snap.fields).filter((f) => !snap.required.includes(f))
        const exception = OPTIONALITY_EXCEPTIONS.get(name)
        if (exception) {
          // Required on Hub rows, absent on every other channel's rows.
          expect(sorted(snapOptional)).toEqual(sorted(exception))
          expect(sorted(ts.optional)).toEqual(sorted(ts.keys))
        } else {
          expect(sorted(ts.optional)).toEqual(sorted(snapOptional))
        }
      })

      it('has the snapshot nullability', () => {
        const snapNullable = Object.entries(snap.fields)
          .filter(([f, s]) => isNullable(s) && !ABSENT_WHEN_NONE.has(f))
          .map(([f]) => f)
        expect(sorted(ts.nullable)).toEqual(sorted(snapNullable))
      })
    })
  }

  it('every snapshot model is mirrored or deliberately not', () => {
    const known = new Set([...Object.keys(HUB_MODEL_KEYS), ...UNMIRRORED_MODELS])
    expect(Object.keys(snapshot).filter((m) => !known.has(m))).toEqual([])
    expect([...known].filter((m) => !(m in snapshot))).toEqual([])
  })

  it('every epoch-seconds field is listed in EPOCH_FIELDS', () => {
    const inSnapshot: string[] = []
    for (const [model, m] of Object.entries(snapshot)) {
      for (const [field, schema] of Object.entries(m.fields ?? {})) {
        if (JSON.stringify(schema).includes('"epoch-seconds"')) inSnapshot.push(`${model}.${field}`)
      }
    }
    expect(sorted(EPOCH_FIELDS)).toEqual(sorted(inSnapshot))
  })

  it('StartConversationResponse pins the hub fields of the project body', () => {
    const s = snapshot.StartConversationResponse
    expect(sorted(Object.keys(s.fields))).toEqual(['hub_target', 'id', 'surface', 'target'])
    expect(s.fields.hub_target).toBe('HubTarget')
    expect(s.fields.target).toBe('ConversationTarget')
  })

  it('the deliveries route answers a bare list of Delivery', () => {
    expect(snapshot.DeliveryList.fields.deliveries).toEqual({ items: 'Delivery', type: 'array' })
  })
})
