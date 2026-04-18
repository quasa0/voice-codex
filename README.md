# realtime-codex-in-webstorm

Voice-first coding assistant in WebStorm based on Codex + OpenAI Realtime API. Built at The IDE Reimagined: JetBrains Codex Hackathon, Shack15, San Francisco, April 18-19, 2026.

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
