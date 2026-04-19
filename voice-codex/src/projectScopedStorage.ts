export function getActiveProjectPath() {
  return (
    (typeof window !== "undefined" ? window.IDEBridge?.projectPath?.trim() : "") ||
    ""
  );
}

export class ProjectScopedStorage {
  private readonly scopeToken: string;

  constructor(projectPath: string) {
    this.scopeToken = encodeURIComponent(projectPath.trim() || "__no_project__");
  }

  private localKey(baseKey: string) {
    return `${baseKey}::${this.scopeToken}`;
  }

  private sessionKey(baseKey: string) {
    return `${baseKey}::${this.scopeToken}`;
  }

  readJson<T>(baseKey: string, fallback: T): T {
    if (typeof window === "undefined") return fallback;
    try {
      const raw = window.localStorage.getItem(this.localKey(baseKey));
      if (!raw) return fallback;
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }

  writeJson<T>(baseKey: string, value: T) {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(this.localKey(baseKey), JSON.stringify(value));
    } catch {
      // Ignore storage quota/transient errors.
    }
  }

  remove(baseKey: string) {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.removeItem(this.localKey(baseKey));
    } catch {
      // Ignore transient storage errors.
    }
  }

  getSessionItem(baseKey: string) {
    if (typeof window === "undefined") return null;
    try {
      return window.sessionStorage.getItem(this.sessionKey(baseKey));
    } catch {
      return null;
    }
  }

  setSessionItem(baseKey: string, value: string) {
    if (typeof window === "undefined") return;
    try {
      window.sessionStorage.setItem(this.sessionKey(baseKey), value);
    } catch {
      // Ignore transient storage errors.
    }
  }
}
