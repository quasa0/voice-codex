# VoiceCodex

VoiceCodex is a JetBrains plugin running inside WebStorm that turns the IDE into a hands-free conversational coding partner. You just talk naturally, keep your hands off the keyboard, and watch Codex do the work inside your IDE.

<img width="1624" height="1284" alt="image" src="https://github.com/user-attachments/assets/c0e5c69a-b523-44af-93f5-d73a66d25cdc" />

## What this repo contains

- `voice-codex/`: the main Vite + React prototype for OpenAI Realtime + Codex app-server integration
- `app/`: a separate app workspace copied from the hackathon project folder
- `hackathon_logs.md`: implementation notes, discoveries, and pivot decisions from the build process

## Current direction

The original goal was realtime voice directly through local `codex app-server`. After debugging auth, model exposure, and realtime support, the project pivoted to:

- OpenAI Realtime API for voice input/output
- Codex app-server for local coding-thread workflows

This keeps the voice path working today while preserving the Codex integration lane for future local-agent orchestration.

## License

MIT
