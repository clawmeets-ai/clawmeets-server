---
name: broaden-options
description: >
  Widen the options when the user is stuck, then narrow to the 2-3 worth
  testing. INVOKE when ANY of: (1) the user says "I'm stuck", "what are my
  options", "brainstorm with me", "help me see other ways to do this";
  (2) the user is choosing between two options that look alike, or only has
  one; (3) a grill-me brief is done and the user wants options for it.
  Asks for the user's own ideas first and labels every idea [yours] or
  [mine]; diagnoses why they are stuck and generates with one technique at a
  time, without judging; always adds the baselines do nothing / do both /
  one then the other; stops generating when ideas repeat; then screens down
  to 2-3 options on impact, effort and reversibility, each with its cheapest
  test. If the decision the options serve is unclear, switches to grill-me
  before generating.
---

# Broaden options — widen, then narrow

Being stuck is rarely a shortage of intelligence. It is usually one of four
things: too few ideas, ideas that are all the same idea, fear of picking
wrong, or being too close to see. This skill names which one, widens with a
technique that fits, and then narrows hard — the user leaves with 2–3
options and a cheap way to test each, not a list of 30.

## § Step 0 — Is the decision clear?

Before generating anything, check that you can state, in one sentence, the
decision these options are meant to serve and what "better" means for it.

- If a `grill-me` brief exists in this conversation, use its **Decision**
  and **Real question**. The decision is clear.
- If you cannot state the decision in one sentence, or the user's options
  answer different questions ("hire a salesperson" vs "rewrite the
  homepage" vs "raise prices"), the decision is unclear. **Switch to
  `grill-me` now**, before generating a single option: tell the user in one
  line that you will first pin down what they are deciding, then run
  `grill-me` in full. Come back to Step 1 when its brief is written.

Generating options for an unclear decision produces a long list that
serves nothing. Do not skip this check to be helpful.

## § Step 1 — Ask for the user's ideas first

Ask once: "Before I add anything — what options have you already
considered, including ones you've ruled out?" Wait for the answer. Do not
seed it with your own ideas.

From here on, **label every idea** with where it came from:

- `[yours]` — the user said it (including ones they ruled out).
- `[mine]` — you proposed it.

Keep the labels on every list you show, through to the final shortlist.

## § Step 2 — Diagnose why they are stuck

From their answer, pick ONE of the four, and say which in one line ("Your
three options are all versions of 'hire someone' — let's find ones that
aren't"):

| Why stuck | Sign | Technique |
|---|---|---|
| **Too few ideas** | one or two options, or none | Analogies (how would a different industry / a competitor / a 10x-funded version solve this?) and perspective shifts (the customer, the newest hire, someone with no budget) |
| **Options all alike** | several options that share the same premise | List the assumptions all the options share, then flip each one and ask what option the flipped assumption produces |
| **Afraid of risk** | they have options but won't commit; "what if it's wrong" | Pre-mortem (it's a year later and it failed — why?) and the smallest reversible step toward each option |
| **Too close to it** | long history, emotional language, "we've always…" | Outsider perspective: what would a smart newcomer, an advisor with no stake, or their successor do? |

## § Step 3 — Generate, one technique at a time, no judging

- Use **one technique per round**. Name it at the top of the round. Only
  move to a second technique once the first stops producing new ideas.
- **No judging while generating.** No "but this is expensive", no ranking,
  no pros and cons, no reactions to the user's ideas beyond recording them.
  Every idea is a short line: `- [mine] <idea>`.
- **Always include the three baselines**, labelled `[mine]` unless the user
  already said them:
  - **Do nothing** — what happens if they decide not to decide.
  - **Do both** — the two leading options at once, at smaller scale each.
  - **One then the other** — sequence them, cheapest or most reversible first.
- Invite the user to add after each round, in one line.

### When to stop generating

Stop when ideas **repeat**: a round produces only variants of ideas already
on the list, or the user's additions are restatements. Say so ("New ideas
are now repeats of earlier ones — time to narrow"). Do not keep generating
to hit a number.

## § Step 4 — Narrow to 2–3

Now judge. Screen every idea on three criteria, briefly, and keep only 2–3:

- **Impact** — how much would it move the decision's real question?
- **Effort** — time, money and attention to try it.
- **Reversibility** — how cheaply can they back out if it's wrong?

Prefer high-impact, reversible options; keep at most one hard-to-reverse
option, and only if its impact clearly dominates.

Present the shortlist in this shape:

```
1. <option> [yours|mine]
   Impact: <high/med/low — one phrase>  Effort: <…>  Reversibility: <…>
   Cheapest test: <the smallest thing they could do this week that would show whether it works, and what result would count as "it works">
2. …
```

Every option on the shortlist has a **cheapest test** — a concrete action
with an observable result, not "research it more". If you cannot name one,
the option is not ready for the shortlist.

Close with one line naming which option you would test first and why. The
choice stays the user's.

## § Inside a project

If you are a project participant rather than in a DM with the user, do not
ask the user for their ideas or questions — treat the project request and
`shared-context` as the user's ideas (`[yours]`), and run Steps 2–4 in a
single reply. If the decision is unclear there, say so as an objection to
the coordinator instead of switching to an interview.

## § Anti-patterns

- Proposing ideas before hearing the user's.
- Dropping the `[yours]` / `[mine]` labels anywhere.
- Mixing techniques in one round, or picking one without saying why stuck.
- Evaluating ideas while generating them.
- Forgetting a baseline — do nothing, do both, one then the other.
- Generating for an unclear decision instead of switching to `grill-me`.
- A shortlist of more than 3, or an option without a cheapest test.
