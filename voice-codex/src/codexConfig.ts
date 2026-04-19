export const DEFAULT_CODEX_PROJECT_CWD = "/Users/personal/realtime-codex-in-webstorm/codex-project-space";
export const CODEX_MODEL = "gpt-5.1-codex-mini";
export const CODEX_REASONING_EFFORT = "low";

export function getCodexProjectCwd() {
  if (typeof window !== "undefined") {
    const ideProjectPath = window.IDEBridge?.projectPath?.trim();
    if (ideProjectPath) return ideProjectPath;
  }
  return DEFAULT_CODEX_PROJECT_CWD;
}
