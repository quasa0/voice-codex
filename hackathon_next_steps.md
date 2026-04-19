# Voice Codex: Next-Step Plan

Saved on 2026-04-18 after reviewing the current prototype against the original hackathon vision.

## Original Vision

The intended product is:

- the user talks only to OpenAI Realtime
- Realtime acts as planner/orchestrator
- Codex app-server acts as worker
- the frontend keeps both systems in sync
- the user always understands:
  - what Codex is doing
  - whether a new utterance started, steered, or interrupted work
  - when Codex needs input
  - when work is actually done

## Current Read

The prototype is already beyond "can this work?" and is now mainly limited by orchestration quality and state consistency.

The biggest remaining risk is not UI polish. It is the gap between:

- what Codex is actually doing
- what the Realtime layer believes is happening
- what the user hears

## Priorities

### 1. Make the orchestration state machine explicit

Move from implicit heuristics to a real per-segment model.

Each Codex segment should explicitly track:

- `segmentId`
- source utterance
- mode: `start | steer | interrupt`
- Codex state: `running | waiting_for_user | completed | failed`
- relay state: `not_spoken | progress_spoken | clarification_spoken | completion_spoken`

This should become the single source of truth for relay behavior.

### 2. Make Codex state first-class

The UI and relay logic should derive a compact real state:

- `idle`
- `running`
- `waiting_for_user`
- `completed`
- `failed`

These should not depend on ad hoc inspection of only the latest message.

### 3. Lock down speaking policy

Default policy:

- On `start`: brief acknowledgement only
- On `steer`: brief acknowledgement only
- On `interrupt`: brief acknowledgement only
- During long runs: only speak progress if the user asks
- If Codex asks a real question: relay it immediately
- On completion: short summary plus short follow-up
- Never auto-speak raw command output or raw plan dumps

### 4. Add an in-chat working indicator

The header badge is not enough.

Inside the conversation timeline, show a transient current-work line tied to the active segment, such as:

- `working...`
- `reading files...`
- `editing index.html...`
- `waiting for input...`

This should update or disappear once the final result lands.

### 5. Make "what happened?" answers timeline-based

Questions like:

- "what is it doing?"
- "why did it do that?"
- "did it interrupt?"
- "what changed?"

should be answered from a structured summary of the current segment timeline, not from whichever assistant message happened most recently.

Recommended segment summary fields:

- files read
- files edited
- commands run
- latest milestone
- blocking question
- final outcome

## What Not To Spend Time On Right Now

Avoid major effort on:

- tiny conversation-layout polish
- prompt-only edge-case patching
- more panels or dashboard surfaces
- open-ended general chat improvements
- non-essential visual flourishes

Those are lower leverage than making the orchestration deterministic.

## Demo Win Condition

The strongest hackathon demo is:

1. User speaks naturally.
2. Realtime decides whether to answer or delegate.
3. Codex visibly works in the background.
4. User changes direction mid-flight.
5. The system clearly shows `steer` or `interrupt`.
6. Codex adapts without chaos.
7. Realtime gives the right spoken summary at the right time.
8. No invented facts and no confusing stale replies.

## Immediate Next Implementation Steps

If continuing development, do these next:

1. Implement the explicit segment/state model in the frontend.
2. Add in-chat active working indicators for the current Codex segment.
3. Replace ad hoc relay behavior with segment-derived summaries for:
   - progress
   - clarification
   - completion
   - "why/what happened" questions

If these three are solid, the original vision is demo-ready enough to present confidently.
