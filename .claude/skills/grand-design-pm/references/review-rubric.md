# Review rubric (DM view and player view)

Score 1-5 and give evidence for every score: quote `transcript.md` (what happened), `notes.md`
(what the GM wrote) and `report.md` / `gm-view-*.html` (what the module did). A finding without a
quote is not a finding.

## DM view

| Area | 5 looks like | Typical findings |
|---|---|---|
| Reading accuracy | Every real action recorded once, for the right character, with the right outcome; traps ignored | missed action, invented action, credited to the wrong PC, failure recorded as success, one action split in two |
| Fairness of growth | Effort, failures and danger count as the rules intend; quiet players are not starved, loud ones not flooded | progress off, danger gap ignored, repeated effort not stacking |
| Proposal quality | You would put it on the table as-is: balanced for the level, correct system terms, clear trigger/frequency | overpowered, useless, PF2e terms in 5e, vague effect, duplicate of an owned Skill |
| Flavor and naming | Names that sound like the character's story and class | generic, repetitive motif, bare class name, silly |
| Red entries | Only for truly dark patterns; drawback is concrete and fair | missed red, red for an ordinary rogue, toothless drawback |
| Workflow and clarity | You understand what happened and what to click; fallbacks explain themselves | confusing labels, silent fallback, too many proposals to triage |
| Speed and cost | Analysis of a session feels instant enough | slow analysis, re-analysis needed |

## Player view (per persona)

| Area | 5 looks like | Typical findings |
|---|---|---|
| Recognition | "It noticed the weird thing I did!" | off-script action ignored or flattened into a generic tag |
| Excitement | You'd brag about the proposal to the table | boring, too small, reads like a spreadsheet |
| Ownership | The Skill is clearly *yours*: your story, your name, your style | generic Fighter ability, someone else's deed |
| Fairness | Your growth vs the others' feels right for what you did | others credited for your moment, dark-path punished or rewarded wrongly |
| Surprise and delight | Something made you laugh or gasp | nothing memorable |

## Findings -> board

For each finding decide: **bug** (the module did something wrong), **quality** (worked, but a GM
or player would not like it), or **qol** (missing convenience). Then file it:

```powershell
node tools/board.mjs add "Party notes credit Maren's beekeeping to every PC" --tag playtest --tag gateway --severity critical --source "ember-road s1"
node tools/board.mjs note <id> "notes: '- Maren moved the hives'; report: Brakka got 'beekeeping' event. Expected: only Maren."
```

One item per root cause. Before filing, check the board for an existing item and add a note to it
instead. End the review with a 3-line summary: best moment, worst moment, fun score (1-10) per side.
