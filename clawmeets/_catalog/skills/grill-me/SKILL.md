---
name: grill-me
description: >
  Narrow a fuzzy decision down to the real question before anyone spends a
  project on the wrong one. INVOKE when ANY of: (1) the user says "grill me",
  "push back on this", "help me think this through", or "what am I really
  deciding"; (2) in a DM, the user brings a decision they keep putting off, or
  asks for research or a comparison that is really in service of one decision
  ("compare 10 CRMs"); (3) `broaden-options` hands off because the decision the
  options serve is unclear; (4) you are a participant in a project whose
  request is a decision and you hold a brief for it. Two modes. In a DM: one
  question per turn, up to about 8 turns, ending in a five-part brief and a
  fixed self-graded closing line. Inside a project: never interview the user;
  review the plan against the brief once before acceptance and the final
  report against "what would change my mind" once.
---

# Grill me — find the real question

People arrive with the question they can say out loud ("which CRM?"). The
decision usually sits one or two layers under it ("do we keep selling to
agencies, or move to in-house teams?"). This skill gets there by asking, and
writes down what it found as a **brief** that the user — and any project that
follows — can work against.

## § Pick the mode first

Read your own prompt before anything else:

- **DM mode** — your role block says `== DIRECT MESSAGE CONVERSATION ==` or
  `== DM COORDINATOR ROLE ==`: you are in a 1:1 conversation with the user.
  Follow § DM mode.
- **Project mode** — anything else: a `== WORKER ROLE ==`, a project
  coordinator role, a workroom, a `milestone-*` room, a `PLAN.md` in the
  synced files. Follow § Project mode.

If you cannot tell, treat it as project mode. Wrongly staying quiet costs one
skipped interview; wrongly interviewing inside a project costs the user's
trust in the whole team.

## § DM mode

### The interview

1. **One question per turn.** Never two, never a numbered list of questions,
   never "a few quick questions". One question, then stop and wait.
2. **Each question builds on the user's last answer.** Quote or name the
   thing they just said that you are pulling on. A question that could have
   been asked before their last answer is the wrong question.
3. Before your question, add at most two sentences: what you just heard, and
   (when it changed) the draft brief part it moved. No lecturing, no advice,
   no options yet — options are `broaden-options`' job.
4. Dig in roughly this order, skipping anything already clear:
   - **The decision** — what will actually be chosen, by whom, by when?
   - **The real question** — why does this decision matter now? What would
     be different if they got it right? Keep asking "and that matters
     because…?" until the answer stops being a means to something else.
   - **The current bet** — if they had to choose today, what would they pick?
     (They almost always have one. Ask for it plainly.)
   - **What would change their mind** — what evidence, if they saw it, would
     flip the bet? Push for something observable, not "if it turns out badly".
   - **What is out of scope** — what are they NOT deciding here?
5. Keep a draft brief in your head (the five parts below) and update it after
   every answer.

### When to stop

Stop asking and write the brief when **either**:

- you have asked about **8 questions**, or
- the draft brief has **not changed for 2 turns in a row** — the last two
  answers confirmed it rather than moved it.

Also stop if the user says "enough", "just write it up", or similar. Do not
stretch to 8 if the brief is already stable.

### The brief

Write it in this shape, in the user's own words wherever possible:

```
**Decision:** <what will be chosen, by whom, by when>
**Real question:** <the question underneath, that the decision actually serves>
**Current bet:** <what they would pick today, and the one-line why>
**Evidence that would change my mind:** <observable things that would flip the bet>
**Out of scope:** <what this decision is not about>

Real question changed from your first message: yes (self-graded)
```

### The closing line — fixed wording, always last

The brief ALWAYS ends with exactly one closing line, and it is the last line
of the message:

```
Real question changed from your first message: yes (self-graded)
```

or

```
Real question changed from your first message: no (self-graded)
```

- You fill in `yes` or `no` yourself. Compare the **Real question** you just
  wrote with the user's FIRST message in this conversation. `yes` if a
  reader would say they are about different things (the first message asked
  "which CRM", the real question is about which customers to serve); `no` if
  the brief only sharpened or restated what they first asked.
- Copy the wording character for character: no bold, no bullet, no trailing
  punctuation, lowercase `yes`/`no`, then ` (self-graded)`. Adoption measures
  parse this line with a fixed prefix; any variation is lost from the count.
- Never omit it, even if the brief is short or the user cut the interview off.

Between the brief and the closing line, offer — in one sentence — the
obvious next step: widen the options with `broaden-options`, or take the
brief into a project. Do not start either unasked, and never put the offer
after the closing line.

## § Project mode

**Inside a project you NEVER interview the user. Not in any room, not once,
not "just one quick question".** Installing this skill cannot enforce that
rule, so it is stated here and it is absolute. The user agreed to a plan;
they did not agree to be grilled through a coordinator. If you think a
question needs the user's answer, write it as an objection (below) and let
the coordinator decide whether to raise it.

### Get the brief

Look, in order, in the project request, the `shared-context` room and its
files, and your delegation message, for a brief with the five parts above
(often pasted from a grill-me DM). If there is none, write a draft brief
yourself from the project request alone, and mark every part you inferred
`(inferred)`. Do not ask anyone to supply it.

### Two reviews, each exactly once

1. **Plan review — once, before the plan is accepted.** Read `PLAN.md`
   against the brief. For each milestone, ask: which brief part does this
   serve? Raise an objection for any milestone that serves none, any brief
   part no milestone serves, and any milestone that works on something the
   brief puts **Out of scope**. Post the review once in `shared-context`;
   do not re-review later drafts unless the coordinator asks.
2. **Final-report review — once, at the final report.** Read the completion
   report against **Evidence that would change my mind**. Say whether the
   project produced that evidence, produced the opposite, or did not look.
   Post it once in your workroom.

### Every objection names the brief part

Each objection names the milestone and the brief part it fails to serve, in
this shape:

```
- <milestone name> does not serve **<brief part>**: <one sentence why>. Suggest: <one-line change>.
```

The brief part is one of: **Decision**, **Real question**, **Current bet**,
**Evidence that would change my mind**, **Out of scope**. An objection that
names no brief part is a taste comment — drop it. If the plan serves every
part, say so in one line and raise nothing.

## § Anti-patterns

- Asking two questions in one turn, or a list "to save time".
- Offering options, advice or a recommendation during the interview.
- Asking a question the user already answered.
- Running past ~8 questions because the brief "could be sharper".
- Paraphrasing the closing line, bolding it, or putting anything after it.
- In a project: any question addressed to the user, directly or relayed.
- In a project: re-running either review on every plan edit.
