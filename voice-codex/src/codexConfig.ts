export const DEFAULT_CODEX_PROJECT_CWD = "/Users/personal/realtime-codex-in-webstorm/codex-project-space";
export const CODEX_MODEL = "gpt-5.4";
export const CODEX_REASONING_EFFORT = "medium";

export function getCodexProjectCwd() {
  if (typeof window !== "undefined") {
    const ideProjectPath = window.IDEBridge?.projectPath?.trim();
    if (ideProjectPath) return ideProjectPath;
  }
  return DEFAULT_CODEX_PROJECT_CWD;
}
