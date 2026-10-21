/**
 * The blank syntax the SOP authoring dialog teaches, and the rail's empty
 * state advertises.
 *
 * Lives outside both components so the zero state can show the same rows
 * without pulling in the dialog. Kept in sync with the parser by hand — the
 * parser is the authority; these are its documentation.
 */
export interface SopSyntaxRow {
  /** Matches PH_TAGS in components/composer/placeholders.ts. */
  kind: 'txt' | 'num' | 'sel' | 'day' | 'who' | 'who+'
  name: string
  code: string
  note: string
}

export const SOP_SYNTAX: SopSyntaxRow[] = [
  {
    kind: 'txt',
    name: 'Free text',
    code: '{{Company}}',
    note: 'The plainest blank — type anything.',
  },
  {
    kind: 'txt',
    name: 'Free text with a default',
    code: '{{Threshold|text:$50}}',
    note: 'Offers $50 pre-typed; accept it or overwrite.',
  },
  {
    kind: 'num',
    name: 'Number',
    code: '{{Count|number:6}}',
    note: 'Numeric field, defaults to 6.',
  },
  {
    kind: 'sel',
    name: 'Pick from a set',
    code: '{{Voice|select:warm,punchy,expert}}',
    note: 'These values are offered up front — comma-separated.',
  },
  {
    kind: 'day',
    name: 'Date',
    code: '{{Deadline|date}}',
    note: 'Today / Tomorrow / End of week / Next Monday. Override with your own list.',
  },
  {
    kind: 'who',
    name: 'Agent',
    code: '{{Approver|agent}}',
    note: 'Picks a teammate from your online roster.',
  },
  {
    kind: 'who+',
    name: 'Several agents',
    code: '{{Mentors|agents}}',
    note: 'Tick as many teammates as you need; defaults to your assistant.',
  },
]

/**
 * A worked example, shown as the prompt field's placeholder.
 *
 * The starter SOPs teach the syntax by example too, but an owner who has
 * deleted them is back to this one string — it earns its length by covering
 * three different kinds.
 */
export const SOP_BODY_PLACEHOLDER = [
  'Reconcile {{Day|date}} for {{Location|select:W8th,JBE,BRBQ}}.',
  'Match POS totals against the books and flag any variance over {{Threshold|text:$50}}.',
  'Post the merged table by {{Deadline|date}}.',
].join('\n')
