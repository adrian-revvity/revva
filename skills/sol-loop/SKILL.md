---
name: sol-loop
description: Use when the user says "sol loop" — multi-round Sol code review before shipping. Vendored from https://github.com/t3dotgg/tstack (skills/sol-loop) and adapted for revva + OpenCode: the T3 `delegate_task` mechanics are replaced by a dedicated reviewer subagent session.
---

# sol-loop (revva / OpenCode adaptation)

This is a workflow for making your code changes more correct before filing a
pull request. tl;dr — use a strong reviewer model (Sol on Bedrock, or the
fallback the user acknowledged) to review your code in a loop.

Make the most minimal possible changes to appease the reviewer. Be careful of
scope creep and don't be scared to push back.

## revva integration notes (read first)

- In revva, the **reviewer is a separate OpenCode session** (model:
  `amazon-bedrock/openai.gpt-6.1-sol` unless the user named another; Bedrock
  readiness required, else an explicitly user-acknowledged fallback — never a
  silent substitution). The reviewer session is read-only: its permission
  ruleset denies edit/write/bash-write.
- The **fixer is the build session** (or a dedicated fixer session on the
  build model). revva passes findings between them; each round is a fresh
  reviewer prompt carrying the ledger — reviewer sessions get no history.
- Where the upstream skill says `orchestrator_capabilities` /
  `delegate_task` / T3 tools, substitute: revva creates the reviewer session
  via the OpenCode API and reports the verdict as the strict reply block
  below. Where it says "native Sol subagent", revva uses the reviewer session
  and keeps its session id as the round's saved id for follow-ups.
- "Outside T3, use a native Sol subagent… If no route runs Sol, report the
  blocker. Do not substitute a model." — in revva this is the pipeline rule:
  no Bedrock readiness ⇒ WAITING_HUMAN with a Morning-not-ready blocker,
  unless the user has ticked the acknowledged-fallback checkbox for this work.

## Budget

- Default: 3 rounds total. Round 1 is full. Later rounds check only
  changed code and open findings.
- Extend to 5 only for security, permissions, auth, data loss, or
  state/concurrency, while a blocker or should stays open with evidence. Or when
  the user asks.
- One reviewer only. The reviewer must not start subagents or reviewers.
- Keep a ledger: id, severity, outcome, usage if returned. Never guess it.

## 1. Scope

Run `git status --short`. Do not stash, discard, or include unrelated
changes. Limit review to the change paths if they separate cleanly.
Otherwise stop and ask.

Find the base after `git fetch origin`:

- PR: `gh pr view <n> --json baseRefName,headRefOid`. Check out the branch
  only if clean. Confirm `HEAD` is the PR head, or ahead only by this
  change. Base: `git merge-base HEAD origin/<baseRefName>`.
- Local: `git merge-base HEAD origin/<default-branch>`. No remote: a base
  the user names, or `HEAD` for uncommitted changes only.

The change is base to working tree in those paths, with untracked files.
Use one diff command all rounds. State intent and out-of-scope in 1-2
sentences. Run covering checks. Do not send code this change breaks. Note
missing or pre-failing checks in the brief.

## 2. Start the reviewer

Record provider, model, and effort only if exposed. New reviewer prompt (or
session continuation of the saved reviewer id) per round. Do not start a
second reviewer.

Round 1 brief:

```
Review only. Do not edit, commit, push, comment on PRs, or start subagents.
Repo: <abs path> Base: <sha> Intent: <intent> Out of scope: <scope> Checks: <results>
See: git diff <base> [-- <paths>]; git status --short (read untracked).
Read surrounding code. Find bugs, broken callers, mismatch with intent.
Skip style unless it hides a bug. Hold to the smallest change. Flag code,
tests, or guards the intent does not need. Other paths, rare cases, small
perf, extra compat: nits.
blocker = intended case wrong. should = real bug callers will hit, in intent. nit = rest.
Reply:
VERDICT: APPROVE or CHANGES
S1 [blocker|should|nit] <file>:<line> <claim>. Fix: <suggestion> (stable ids)
```

Do not edit scoped files while review runs. Wait for the reply. Timeout,
error, or no reply is not approval. On failure, cancel, verify stop, restart
with the ledger.

## 3. Answer findings

Check each finding and severity yourself. Another path, rare case, or small
cost is a nit, whatever label it came with.

- Agree: smallest fix. Prefer delete or narrow over new lock, cache, helper,
  or option. Fix the case that happened. Add one focused test that fails
  without the fix, if intent needs it.
- Disagree: say why, with evidence (file:line, test, output).
- Out of scope or nit: decline in one line. List as follow-up.

Update the ledger. Re-run checks and `git diff --shortstat <base>`. If
review grew the diff, cut first. Do not agree just to end the loop.

## 4. Next round

Start one only if budget remains and a blocker or should is open, behavior
code changed, or approval does not cover the current behavior diff. Send the
round 1 brief, the ledger (`fixed:` / `disagree:` / `declined:` + evidence),
the same base diff, and the change since last round. Tell the reviewer:
open ids and changed code only. Mark each old id `resolved` or
`still open: <reason>`.

## 5. Stop and ship

Agreed: APPROVE on the current behavior diff, no blocker or should open, no
concern of your own. Stuck: an item stays disputed after two replies, or
budget ends. Show both sides in 2-3 lines each. The user decides.
Budget end is not approval.

Do not push during the loop. Push after agreement only if the user asked to
push, ship, or update the PR. If you push to a PR, add above the model
blurb:

`Reviewed with sol-loop: <N> rounds with <model>. Reviewer verdict: approved`.

Add `on <effort>` only if verified.

Report: rounds, model, what the reviewer changed, diff size before/after,
fixed and declined findings with reasons, usage if exposed (else say not),
pushed or not.
