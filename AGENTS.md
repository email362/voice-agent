# Voice Agent Project Agent Rules

## Scope and Ownership

This file governs agents working with the `voice-agent` source repository, including the voice-agent Project Agent. The source repository is authoritative for code, tests, branches, commits, and runtime evidence. Canonical durable project state lives in HyerOS under `/home/chyer/projects/HyerOS/01 Projects/voice-agent/**` and remains subject to HyerOS ownership, approval, validation, and guarded-Git rules.

## Event-Driven Rolling State Refresh

Before completing any Project Agent run that materially changes project truth or newly verifies project truth, refresh these canonical HyerOS rolling records once near the end of the run:

- `/home/chyer/projects/HyerOS/01 Projects/voice-agent/00 Control/status.md`
- `/home/chyer/projects/HyerOS/01 Projects/voice-agent/00 Control/workflow-state.yaml`

A refresh is required when the run materially changes or newly verifies any of the following:

- lifecycle phase, stage, status, or project health;
- source branch, commit, working-tree state, tests, validation, deployment, or live evidence;
- durable project documentation or accepted worker results;
- decisions, approvals, blockers, risks, assumptions, or provenance;
- next action, owner, or forecast.

Use the final verified evidence from the run. Update the two rolling records once after material work and review are complete rather than after every individual edit. The refresh itself does not trigger another refresh.

Do not update rolling state for:

- every individual file edit;
- unaccepted worker or specialist output;
- a no-op interaction with no durable change and no newly verified evidence.

## Reporting Cadence

Voice-agent Project Agent reporting is event-driven. There is no standing Wednesday/Sunday Project Agent summary requirement. The daily Chief of Staff automation is separate and unchanged.

## Guarded Write Behavior

Before writing canonical state, verify the expected repositories and branches, clean starting state, and non-divergent remotes. Modify only authorized Project Agent paths, validate the full HyerOS workspace and exact changed-path ownership, and use normal non-force Git operations.

If the rolling-state write, validation, commit, or push is blocked, leave repository state safe. Publish the Project Agent report anyway and identify the exact `status.md` and/or `workflow-state.yaml` update that was withheld, together with the blocking Git, validation, permission, or evidence condition. Do not overwrite, force-push, edit Chief-of-Staff-owned paths, or route around the failure.
