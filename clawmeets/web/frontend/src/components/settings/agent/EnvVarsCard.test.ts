import { describe, expect, it } from 'vitest'
import { envKeyProblem, envValueProblem } from './EnvVarsCard'

describe('env var key rules', () => {
  it('matches the store: upper-case, digits, _; no leading digit; no CLAWMEETS_', () => {
    expect(envKeyProblem('')).toBeNull()
    expect(envKeyProblem('STRIPE_API_KEY')).toBeNull()
    expect(envKeyProblem('_X1')).toBeNull()
    expect(envKeyProblem('1ABC')).toBe("Can't start with a digit")
    expect(envKeyProblem('A-B')).toBe('Letters, digits and _ only')
    expect(envKeyProblem('CLAWMEETS_TOKEN')).toBe('CLAWMEETS_ is reserved')
    expect(envValueProblem('x'.repeat(8192))).toBeNull()
    expect(envValueProblem('x'.repeat(8193))).not.toBeNull()
  })
})
