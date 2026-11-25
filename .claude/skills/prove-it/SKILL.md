---
name: prove-it
description: Build features that are proven to work, not claimed to work. Use whenever building, changing or fixing anything in a project, and before reporting any task as done. Sets the bar for "done" (irrefutable, reproducible evidence), how to iterate (build tools and run experiments instead of guessing), and how to leave the project legible to the next human or agent. Triggers on "build", "implement", "add", "fix", "ship", "is it done", "does it work", "make sure it works".
---

# Prove it

A feature is done when there is evidence that it works, that anyone can re-run. Not when the code is
written, not when it compiles, and not when it "should" work.

Based on Thorsten Ball's notes on working with coding agents (Oct 2026), adapted as a working rule.

## 1. Define done before building

Before writing code, write down in one or two lines:

- **What** must be true when it works, from the user's or the system's point of view. Not how to build it.
- **The proof** that will show it: which test, command, transaction, number or recording.
- **The failure cases** that must be rejected (over the limit, wrong user, bad input), not just the
  happy path.

If you cannot say what the proof will be, the task is not understood yet. Find out first.

## 2. What counts as evidence

Evidence is something that ran against the real thing and could have failed:

- A test that exercises the real code path, with both passing and rejecting cases, and the command to
  re-run it.
- An end-to-end run: real network or testnet transaction (with its hash or explorer link), real
  binary, real browser.
- Before/after numbers measured on the same machine, with how they were measured.
- Parity against an independent source: a golden value read from the live system, a second
  implementation, a spec's test vector.
- A recording or screenshot of the actual product doing the thing.

## 3. What is NOT evidence

- "It compiles", "the types check", "it should work", "I've implemented X".
- A test that only asserts what the code just computed (tautology), or that cannot fail.
- A negative test that passes because setup broke, not because the system rejected the input. Pair
  every rejection test with a passing case on the same setup.
- Mocks standing in for the thing being proven. Mock the edges you don't own, never the thing under test.
- Numbers typed by hand into docs. Generate them from the build.
- A previous run before the latest change. Re-run after every change.

## 4. Iterate with tools, not guesses

- Don't try-one-thing-then-another. Build the harness that tries many: a script, a matrix test, a
  page that compares variants.
- When something is wrong or slow, write several theories down and check all of them, in parallel
  where possible. Report which held.
- Make the whole lifecycle visible: if you can't see logs, chain state, the deployed version or the
  browser, get access or build a tool that shows it. Anything you can't see, you'll end up inventing.
- Run what you build end to end yourself before handing it over.

## 5. Leave it legible

- One command proves the project still works (e.g. `make verify`). Keep it green.
- Generated evidence lives in the repo (e.g. `docs/evidence/`), with the commit it was produced at.
- Record decisions and why, next to the code (a short doc or ADR), so the next person or agent does not
  redo the work.
- Keep an `AGENTS.md` / `CLAUDE.md` with how to build, test and verify, and the "not evidence" list.

## 6. Review where the blast radius is

Spend human review on the few high-impact places: contracts, circuits, money movement, auth, keys,
migrations. Elsewhere ask: does it work (proof), do I understand it at the boxes-and-arrows level,
can I change it in a month?

## 7. Work asynchronously and ambitiously

- Hand over bigger tasks with a clear "what" and a clear proof, then let the work run.
- Use schedules and check-ins for anything that takes time: "check the deploy in 2 hours", "re-run the
  testnet check every morning".
- Batch questions instead of drip-feeding them.
- Always use the strongest model available. A model that is wrong 10% of the time costs more in
  retries than it saves.

## Report format when finishing a task

1. What now works, in one or two sentences.
2. The evidence: commands run, results (pass counts, tx hashes, numbers), and where it is recorded.
3. What was not verified, and why. Never hide a skipped step.
4. What is next.
