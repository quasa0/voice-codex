# realtime-codex-in-webstorm-plugin

![Build](https://github.com/quasa0/realtime-codex-in-webstorm-plugin/workflows/Build/badge.svg)
[![Version](https://img.shields.io/jetbrains/plugin/v/MARKETPLACE_ID.svg)](https://plugins.jetbrains.com/plugin/MARKETPLACE_ID)
[![Downloads](https://img.shields.io/jetbrains/plugin/d/MARKETPLACE_ID.svg)](https://plugins.jetbrains.com/plugin/MARKETPLACE_ID)

<!-- Plugin description -->
JetBrains plugin that embeds the Realtime Agent + Codex app-server UI inside WebStorm and opens files Codex is working on.
<!-- Plugin description end -->

## Development

1. Start the `voice-codex` web app:

   ```bash
   cd ../voice-codex
   npm install
   npm run dev
   ```

2. Run the plugin in a sandbox IDE:

   ```bash
   ./gradlew runIde
   ```

3. Open the `VoiceCodex` tool window on the right side of the sandbox IDE.

The current plugin shell loads:

`http://localhost:5173?embed=true`

That keeps the React app as the main UI while the JetBrains plugin acts as the IDE host shell.

---
Plugin scaffold based on the [IntelliJ Platform Plugin Template][template].

[template]: https://github.com/JetBrains/intellij-platform-plugin-template
