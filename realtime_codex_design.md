# Realtime + Codex Design

## Goal

Make the user interact only with the OpenAI Realtime agent by voice or text, while Codex app-server does the actual coding work in the background.

## Roles

### OpenAI Realtime
- Talks to the user.
- Interprets intent.
- Decides whether to:
  - answer directly,
  - ask a clarification question,
  - start a Codex task,
  - steer an in-flight Codex task,
  - interrupt and replace a Codex task,
  - summarize Codex progress back to the user.

### Codex app-server
- Works on the codebase.
- Reads files, edits files, runs commands, and emits activity/logs.
- Acts like a worker, not the primary conversational interface.

### Frontend orchestrator
- Connects Realtime and Codex.
- Maintains session state.
- Sends structured instructions from Realtime to Codex.
- Feeds compact Codex status/results back into Realtime.
- Prevents chaotic overlapping actions.

## Product Behavior

### User experience
1. User speaks to Realtime.
2. Realtime decides whether Codex is needed.
3. If not needed, Realtime answers directly.
4. If needed, the frontend sends a task into Codex.
5. Codex works while the UI shows logs and activity.
6. Realtime decides whether to speak updates while Codex is running.
7. When Codex finishes or needs clarification, Realtime talks back to the user.

### Important principle
Realtime is not just a microphone front-end.
Realtime is the planning/orchestration agent.
Codex is the coding execution tool.

## Minimal Action Schema

Each finalized Realtime turn should resolve to one of a small set of actions:

```json
{ "action": "respond", "message": "..." }
```

```json
{ "action": "ask_user", "message": "..." }
```

```json
{ "action": "codex_start", "task": "..." }
```

```json
{ "action": "codex_steer", "task": "..." }
```

```json
{ "action": "codex_interrupt", "task": "..." }
```

```json
{ "action": "codex_status" }
```

## Codex State Model

Codex should expose a compact state to Realtime:

- `idle`
- `running`
- `waiting_for_user`
- `completed`
- `failed`

And a short status summary, for example:

- current task
- latest meaningful step
- recent result
- error if any

## Guardrails

- Do not send every raw log line into Realtime.
- Do not let Realtime and Codex free-run independently.
- Do not allow overlapping Codex turns without explicit interruption logic.
- Prefer structured summaries over raw event spam.
- Do not interrupt Codex just because the user keeps talking.
- Treat normal conversation, brainstorming, and architecture discussion as non-interrupting by default.
- Only send a new action to Codex when the user's intent to change Codex behavior is clear.
- Avoid confirmation loops. Realtime should infer intent from context instead of repeatedly asking "should I do that?"

## First Implementation Step

Implement a one-way bridge:

1. Final Realtime transcript arrives.
2. Realtime chooses `respond` or `codex_start`.
3. Frontend executes that action.
4. Codex activity is shown in the UI.
5. Frontend produces a compact Codex summary.
6. Realtime decides whether to speak that summary.

## Next Step After That

Add steering and interruption:

- `codex_steer` for adding direction to an active task
- `codex_interrupt` for replacing the current task

## Open Questions

- Should Realtime proactively speak progress updates during long Codex runs, or only when the user asks?
- Should user speech during an active Codex run default to steer, interrupt, or clarification mode?
- Should Codex progress be summarized continuously, or only at milestones like file edit, command result, or completion?

## User Preference Decisions

These are now the intended defaults for this project:

- The user should be able to keep talking to Realtime while Codex is working.
- Casual discussion should not kill or interrupt the active Codex task.
- Realtime should distinguish between:
  - normal conversation,
  - architecture discussion,
  - explicit steering,
  - explicit interruption/replacement.
- Realtime should only send a Codex action when there is clear action intent in the user's speech.
- Realtime should infer intent from context and avoid annoying confirmation questions.
- If the user is "just yapping," Realtime should continue the conversation without touching Codex.
- If the user clearly redirects implementation, Realtime may steer or interrupt Codex without asking for confirmation.
