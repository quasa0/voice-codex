# Voice Codex: Final Hackathon TODO

Saved on 2026-04-19.

## Current State

The core demo path is working:

- voice-first orchestration through OpenAI Realtime
- Codex running as the coding worker
- visible Codex progress and completion summaries
- JetBrains/WebStorm embedding
- IDE diff opening for Codex edits

At this point, the remaining work is polish on the Codex conversation panel, not product expansion.

## Only Remaining TODOs

### 1. Proper Markdown Rendering In Codex Chat

Codex messages should render as real markdown in the conversation panel, including:

- headings (`#`, `##`)
- lists
- links
- bold
- inline code
- code fences

This should apply while messages are streaming, not only after the final message lands.

### 2. Inline Diff Preview For `Updated files`

When Codex emits an edit/update message, show a small inline diff preview directly in the Codex chat.

Target behavior:

- green additions
- red deletions
- capped preview size
- roughly 5 added lines max
- roughly 5 removed lines max
- truncate anything beyond that

This should be sourced from structured file-change data, not scraped back out of prose summaries.

## Demo Goal

Ship the current system with:

1. natural voice request
2. Codex background execution
3. visible progress
4. IDE-native diff visibility
5. polished Codex chat rendering

That is enough.
