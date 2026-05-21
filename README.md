# VoiceCodex

VoiceCodex is a JetBrains plugin running inside WebStorm that turns the IDE into a hands-free conversational coding partner. You just talk naturally, keep your hands off the keyboard, and watch Codex do the work inside your IDE.

<img width="1624" height="1284" alt="VoiceCodex command center" src="https://github.com/user-attachments/assets/c0e5c69a-b523-44af-93f5-d73a66d25cdc" />

## Why

Coding with an agent still usually means staying glued to the keyboard: typing prompts, watching logs, copying context, and checking what changed. VoiceCodex makes Codex feel like a teammate inside the IDE. You can talk naturally, ask side questions while work is running, and see the actual file changes appear in WebStorm.

## Hackathon

VoiceCodex was built as part of the [JetBrains x OpenAI Hackathon](https://cerebralvalley.ai/events/~/e/jetbrains-x-openai-hack?modalCloseUrl=%2Fevents%2Fregistered), held April 18-19, 2026 in San Francisco. The event had 39 submitted projects in the [project gallery](https://cerebralvalley.ai/e/jetbrains-x-openai-hack/hackathon/gallery) and about 350 registered participants. The project received strong feedback from judges during private judging, though it was not selected as one of the top 6 projects invited to present on stage. Watch the [hackathon submission demo](https://www.youtube.com/shorts/NooDSUSjDvs).

VoiceCodex was designed around side questions that do not interrupt the main execution, making it an early implementation of the interaction pattern later shown in OpenAI's [Realtime agent demo](https://www.youtube.com/watch?v=JOu8v6CBjkE&t=1s).

## How It Works

- **OpenAI Realtime** listens to the user, interprets intent, answers conversationally, and decides when coding work should be sent to Codex.
- **Codex app-server** reads files, edits code, runs commands, and reports progress back to the voice interface.
- **React and Vite** power the embedded command center UI shown inside the JetBrains tool window.
- **JetBrains plugin shell** hosts the web app inside WebStorm and can open files, show diffs, and control IDE state.
- **Structured orchestration** keeps normal conversation, active coding tasks, steering, and interruptions separate.
- **pnpm** is used for local development: `pnpm install`, `pnpm dev`, and `pnpm build`.
