# Running a playtest session (DM guide)

## Before the session

- `playtest.mjs status --campaign <name>` - who has what, pending proposals, Grand Design levels.
  Weave last session's approved Skills into the fiction so players get to *use* them (that is
  where "is this fun?" is really answered).
- Plan 3 beats: a fight (danger gap: sometimes let them face something far stronger), a social or
  investigation scene, and a downtime/off-script beat ("the caravan stops in town for two days -
  what do you do?"). Leave room for what the chaos persona will do instead.

## At the table

1. Frame the scene in 3-6 sentences. Name the stakes.
2. Send the scene to every player agent **in parallel** (one Agent call each, or SendMessage to
   continue an existing player). Collect all declared actions.
3. Resolve honestly with real dice - never fudge toward a result the module "should" see:
   ```
   node -e "const {randomInt}=require('crypto'); const d=randomInt(1,21); console.log('d20', d, 'total', d+5)"
   ```
   Use the system's rules loosely but correctly (PF2e: degrees of success, DC; dnd5e:
   advantage/disadvantage, saves). Record nat 1s and nat 20s.
4. Narrate outcomes for everyone, then the next round. 3-6 rounds per beat.
5. Log everything in `sessions/NN/transcript.md`:
   ```
   ## Beat 2 - the toll bridge (social)
   **DM:** ...
   **Wick (chaos-gremlin):** I challenge the troll to a riddle contest for the toll.
   **Roll:** Wick Deception d20=17 +6 = 23 vs DC 18 -> success
   **DM:** ...
   ```
   At the end, list the ground truth per character: what they actually did (attempted), results,
   and which moments you, the DM, would reward with growth. Reviewers compare the module to this.

## Writing the session notes (what the module reads)

Real GMs write every kind of note. Rotate the style each session, and note the style at the top
of `transcript.md` (never in `notes.md` - the module must cope unaided):

| Style | Looks like |
|---|---|
| tidy recap | Paragraphs, past tense, names every PC. |
| bullets | `- Brakka: held bridge, 3 goblins, took a cut` fragments. |
| shorthand | `wick nat20 riddle vs troll ez, free toll lol` |
| player chat | Each player's own one-line recap in their persona's style, pasted together. |
| mixed language | Some lines in the polyglot's language, or code-switched. |
| long messy | One run-on paragraph, asides, OOC chatter, pizza, rules arguments. |

Include some traps honestly (a plan for next session, a rules question, OOC talk): real notes have
them, and the module must not turn them into growth.

## After the notes: run the module and act as the GM

```powershell
node foundry-module/tools/playtest/playtest.mjs analyze --campaign <name> --session NN --rest long
node foundry-module/tools/playtest/playtest.mjs approve --campaign <name> --actor Wick --proposal "Riddle"
```

Approve what you would genuinely allow at your table (balanced, fitting, fun). Write down why you
rejected the rest - rejections are findings too ("bland", "too strong", "not what happened").

Each character is analyzed with the SAME party notes, exactly like a GM pasting one recap into
every character sheet. Watch who gets credited for what.
