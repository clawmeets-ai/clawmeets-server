import { describe, expect, it } from 'vitest'
import { ApiError } from '../api/client'
import { labelErrorCopy, labelErrorMessage, parseLabelError } from './labelErrors'
import { toRegistry } from './labelView'

const api = (status: number, detail: string) => new ApiError(status, detail, { detail })

/** Every code in contract §9's table, plus the two fallbacks that matter more
 *  than any of them. */
const CODES = [
  'labels.cap_exceeded',
  'labels.invalid_slug',
  'labels.slug_too_long',
  'labels.name_too_long',
  'labels.duplicate',
  'labels.kind_conflict',
  'labels.kind_mismatch',
  'labels.kind_immutable',
  'labels.registry_full',
  'labels.unknown_color',
  'labels.unknown_slug',
  'labels.unknown_merge_target',
  'labels.merge_self',
  'labels.invalid_kind',
  'labels.invalid_type',
]

describe('parseLabelError', () => {
  it.each(CODES)('%s parses into code + sentence', (code) => {
    const p = parseLabelError(api(400, `${code}: a human sentence`))
    expect(p.code).toBe(code)
    expect(p.sentence).toBe('a human sentence')
    expect(p.status).toBe(400)
  })

  it('parses err.MESSAGE, not err.data — the client already lifted detail', () => {
    // api/client.ts lifts `detail` into ApiError.message. Reaching into
    // err.data works today and breaks on the first non-JSON body.
    const e = new ApiError(400, 'labels.duplicate: label "office" already exists', 'raw text')
    expect(parseLabelError(e).code).toBe('labels.duplicate')
  })

  it('an UNCODED error falls back to the whole detail string', () => {
    // Every other error in this codebase is uncoded. A client that assumes a
    // code breaks on the first 401 or any non-label 404.
    const p = parseLabelError(api(401, 'Authentication required'))
    expect(p.code).toBeNull()
    expect(p.sentence).toBe('Authentication required')
    expect(p.status).toBe(401)
  })

  it('a plain Error, a string and an unknown throw all yield a usable sentence', () => {
    expect(parseLabelError(new Error('network down')).sentence).toBe('network down')
    expect(parseLabelError('boom').sentence).toBe('boom')
    expect(parseLabelError(undefined).sentence).toBeTruthy()
    expect(parseLabelError(undefined).code).toBeNull()
  })

  it('does not throw on any of them', () => {
    for (const v of [null, undefined, 0, {}, [], new Error('')]) {
      expect(() => parseLabelError(v)).not.toThrow()
    }
  })

  it('a near-miss prefix is NOT treated as a code', () => {
    expect(parseLabelError(api(400, 'label.duplicate: nope')).code).toBeNull()
    expect(parseLabelError(api(400, 'labels: nope')).code).toBeNull()
  })
})

describe('labelErrorCopy', () => {
  const reg = toRegistry([], 'ready')

  it('kind_conflict is STILL MAPPED — it renders the server sentence now', () => {
    // THIS ASSERTION TESTED COPY THAT NAMED AN AXIS THAT NO LONGER EXISTS. It
    // read "kind_conflict copy is GENERATED and names the key to press", and
    // the generated half was the point: the client held the other row's kind,
    // so it could say "press ! instead" where the server could only describe
    // the conflict. There is no other kind and no second key, so `wanted` and
    // `otherKind` are gone from `LabelErrorContext` with the rewrite they fed.
    //
    // WHAT REPLACED IT is the thing that must NOT change: the CODE stays
    // mapped. The server can still emit `labels.kind_conflict` for a registry
    // row written before the retirement, and an unmapped code renders raw on
    // screen. So the case survives and renders the server's own sentence, which
    // is already written for the owner.
    const detail = '"next" is a state, not a context'
    const msg = labelErrorMessage(api(409, `labels.kind_conflict: ${detail}`), { slug: 'next' })
    expect(msg).toBe(detail)
    expect(msg).not.toContain('press !')
  })

  it('the other three kind codes stay mapped too, and render a real sentence', () => {
    // Never "something went wrong": all four are reachable for a pre-existing
    // row, and dropping one turns a legible refusal into a raw code.
    for (const code of ['labels.invalid_kind', 'labels.kind_immutable', 'labels.kind_mismatch']) {
      const msg = labelErrorMessage(api(409, `${code}: a sentence for the owner`))
      expect(msg).not.toContain(code)
      expect(msg.length).toBeGreaterThan(0)
      expect(msg).not.toBe('Something went wrong. Try again.')
    }
  })

  it('cap_exceeded keeps the server RESULT count verbatim', () => {
    // "got 10" on an 8-label item plus two — the number the owner needs.
    const msg = labelErrorMessage(api(400, 'labels.cap_exceeded: at most 8 labels per to-do (got 10)'))
    expect(msg).toContain('got 10')
  })

  it('an UNRECOGNISED labels.* code still shows the server sentence', () => {
    // The whole reason code and sentence are separate fields on the wire.
    const msg = labelErrorMessage(api(400, 'labels.some_future_code: the future is unevenly distributed'))
    expect(msg).toBe('the future is unevenly distributed')
    expect(msg).not.toMatch(/something went wrong/i)
  })

  it('an uncoded 401 renders its own words, not a shrug', () => {
    expect(labelErrorMessage(api(401, 'Authentication required'))).toBe('Authentication required')
  })

  it('takes a pre-parsed error too', () => {
    expect(labelErrorCopy(parseLabelError(api(400, 'labels.merge_self: cannot merge')), {})).toContain(
      'cannot be merged into itself',
    )
    expect(reg.labels).toEqual([])
  })
})
