import { describe, expect, it, vi, beforeEach } from 'vitest'

/**
 * The wire contract of the three association routes, asserted at the seam where
 * a wrong verb or a wrong body shape stops being a type error and becomes a
 * 404 the owner reads.
 *
 * Two properties here are not obvious from the signatures and are exactly what
 * a tidy-up would break:
 *  - `project_id` is a BODY field on POST (`Body(..., embed=True)`) and a PATH
 *    SEGMENT on DELETE. The asymmetry is the server's, not a mistake, and the
 *    path form is the one that has to be encoded.
 *  - `TodoProjectRow` has no `| null` anywhere. A dangling row OMITS its
 *    descriptive keys and still carries `contributes`, so a reader never has to
 *    tell absent from null. That is asserted against a literal wire row rather
 *    than trusted to the type.
 */

const post = vi.fn()
const del = vi.fn()
const get = vi.fn()
vi.mock('../client', () => ({
  post: (...a: unknown[]) => post(...a),
  del: (...a: unknown[]) => del(...a),
  get: (...a: unknown[]) => get(...a),
}))

const {
  associateTodoProject,
  dissociateTodoProject,
  getTodoProjects,
} = await import('./deskTodoProjects')
type TodoProjectRow = import('./deskTodoProjects').TodoProjectRow

beforeEach(() => {
  post.mockReset().mockResolvedValue({})
  del.mockReset().mockResolvedValue({})
  get.mockReset().mockResolvedValue([])
})

describe('the association endpoints', () => {
  it('POSTs the project id in the BODY, embedded under project_id', async () => {
    await associateTodoProject('t-9a3f21', 'p-4c1e')
    expect(post).toHaveBeenCalledWith('/me/desk/todos/t-9a3f21/projects', {
      project_id: 'p-4c1e',
    })
  })

  it('DELETEs the project id as a PATH SEGMENT, encoded', async () => {
    // A dangling id is arbitrary stored text and `dissociate` is the ONE route
    // that has to survive it — it is the only way an owner clears a link whose
    // project is gone. An unencoded slash would address a different route
    // entirely and answer 404, which reads to the owner as "this cannot be
    // removed" for the exact row that most needs removing.
    await dissociateTodoProject('t-9a3f21', 'p-with/slash and space')
    expect(del).toHaveBeenCalledWith(
      '/me/desk/todos/t-9a3f21/projects/p-with%2Fslash%20and%20space',
    )
  })

  it('GETs the association rows', async () => {
    await getTodoProjects('t-9a3f21')
    expect(get).toHaveBeenCalledWith('/me/desk/todos/t-9a3f21/projects')
  })

  it('a dangling row carries contributes and OMITS the descriptive keys', () => {
    // The literal wire shape the server emits for an id that no longer
    // resolves. `contributes` being present is what lets it be typed REQUIRED:
    // were it omitted, a reader would have to read ABSENT as false, which holds
    // until a resolved-but-FAILED project sends a genuine `contributes: false`
    // — and then two wire shapes mean one thing.
    const dangling: TodoProjectRow = {
      id: 'p-deleted',
      resolved: false,
      contributes: false,
    }
    expect(dangling.contributes).toBe(false)
    expect('status' in dangling).toBe(false)
    expect(dangling.display_name).toBeUndefined()
  })

  it('is_dm is read, never derived — a frontdesk thread is dm-shaped', () => {
    // `Project.is_dm_shaped` is true for BOTH "dm" and "frontdesk", so
    // `surface === 'dm'` gets every Front Desk thread wrong. This row is the
    // counterexample, written down so the derivation is not reinvented.
    const fd: TodoProjectRow = {
      id: 'p-fd',
      resolved: true,
      contributes: true,
      display_name: 'Ask the vendor',
      name: 'ana-fd-vendor-1a2b3c4d',
      status: 'active',
      surface: 'frontdesk',
      is_dm: true,
    }
    expect(fd.is_dm).toBe(true)
    expect(fd.surface === 'dm').toBe(false)
  })
})
