# Hackathon Logs

## Goal

Build a minimal React + TypeScript web app that connects to the local Codex app-server over WebSocket and enables voice-to-code via WebRTC.

Target flow:

1. Connect to `codex app-server`
2. Start a Codex thread
3. Start a voice session with `thread/realtime/start`
4. Send mic audio to the agent and hear audio back
5. Show JSON-RPC logs and agent activity in the UI

## What We Built

- A Vite React + TypeScript app in `voice-codex`
- WebSocket connection UI with JSON-RPC logging
- Thread creation UI
- Agent activity panel
- WebRTC offer generation and remote SDP handling
- Local proxy so the browser can talk to `codex app-server` despite browser `Origin` restrictions
- Account status UI
- API-key login/logout UI for app-server auth endpoints

## Key Discoveries

### 1. `codex app-server` does not expose a default WebSocket port

It defaults to `stdio://`, not a TCP listener. To expose WebSocket manually:

```bash
codex app-server --listen ws://127.0.0.1:3000
```

### 2. Browser cannot connect directly to app-server WebSocket

`codex app-server` rejects requests with an `Origin` header. Browsers always send one for WebSocket handshakes, so we added a local proxy on port `3001`.

### 3. The app-server protocol requires initialization sequence

The correct startup flow is:

1. `initialize`
2. `initialized`
3. then normal requests like `thread/start`

### 4. `thread/start` parameter names are version-sensitive

The sandbox enum had to be `workspace-write`, not `workspaceWrite`.

### 5. API-key auth and ChatGPT auth are separate problems

At first, app-server kept using ChatGPT auth because Codex shared auth state from `~/.codex`, likely including desktop-app login state.

We fixed that by:

- running app-server with isolated `CODEX_HOME`
- then explicitly logging in via JSON-RPC:

```json
{
  "method": "account/login/start",
  "params": {
    "type": "apiKey",
    "apiKey": "sk-..."
  }
}
```

Confirmed via:

```json
{
  "result": {
    "account": {
      "type": "apiKey"
    }
  }
}
```

### 6. The biggest blocker is not auth anymore

Even after confirmed `apiKey` auth, `model/list` from `codex app-server` still only exposed Codex/GPT-5 models such as:

- `gpt-5.3-codex`
- `gpt-5.4`
- `gpt-5.2-codex`
- `gpt-5.1-codex-max`

It did **not** expose realtime-capable models like:

- `gpt-realtime`
- `gpt-realtime-mini`

### 7. Our OpenAI API key *does* have realtime access

Direct API model listing showed realtime models were available to the account, including:

- `gpt-realtime`
- `gpt-realtime-mini`
- `gpt-realtime-1.5`
- `gpt-4o-realtime-preview`

So the limitation is specifically in `codex app-server` model exposure, not in OpenAI account access.

### 8. Final conclusion

`codex app-server` in this setup supports the realtime protocol surface, but does not currently expose a realtime-capable model for local threads, even under confirmed API-key auth.

That means `thread/realtime/start` is not viable for our goal in the current Codex path.

## Current Working State

The frontend can now:

- connect to app-server through the local proxy
- initialize correctly
- start threads successfully
- show JSON-RPC traffic
- show agent events
- display current auth mode
- log into `apiKey` mode from the UI
- log out from the UI

But voice via `thread/realtime/start` still fails because the selected Codex thread model does not support realtime conversation.

## Pivot Plan

We are pivoting to a split architecture:

### Keep Codex app-server for:

- coding threads
- file edits
- shell commands
- agent activity
- tool-driven coding workflow

### Use OpenAI Realtime API directly for:

- low-latency voice input/output
- browser audio streaming
- speech interaction

## Why This Pivot

This keeps the parts that already work:

- Codex is still used for coding
- OpenAI Realtime API is used for voice

The downside is that we now need orchestration between two systems instead of one. But this is still better than blocking on a Codex app-server capability that does not appear to be exposed in the current release.

## Recommended Next Architecture

1. Browser talks to OpenAI Realtime API for audio session
2. User speech is converted into instructions
3. App sends those instructions into a Codex thread over app-server
4. Codex performs edits / commands / coding actions
5. App streams activity and results back into UI
6. Optionally summarize Codex results back through the realtime voice layer

## Notes

- Rotate any API keys that were pasted during debugging
- The current frontend already has useful plumbing we can reuse:
  - connection handling
  - JSON-RPC logging
  - account status
  - thread creation
  - activity display
- The next implementation step should be replacing the current voice/session path with direct OpenAI Realtime API integration
