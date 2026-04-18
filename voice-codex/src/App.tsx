import { useCallback, useEffect, useRef, useState } from "react";
import { useCodexWebSocket } from "./useCodexWebSocket";
import { useVoiceSession } from "./useVoiceSession";
import { useOpenAIRealtime } from "./useOpenAIRealtime";
import type { LogEntry, AgentEvent, ModelInfo } from "./types";
import "./App.css";

const AGENT_METHODS_OF_INTEREST = new Set([
  "turn/started",
  "turn/completed",
  "item/started",
  "item/completed",
  "item/fileChange/outputDelta",
  "item/commandExecution/outputDelta",
  "item/agentMessage/delta",
  "thread/realtime/sdp",
  "account/updated",
]);

function LogPanel({ entries }: { entries: LogEntry[] }) {
  return (
    <div style={styles.panel}>
      <div style={styles.panelHeader}>JSON-RPC Log</div>
      <div style={styles.scrollArea}>
        {entries.map((e) => (
          <div
            key={e.id}
            style={{ ...styles.logEntry, borderLeftColor: e.direction === "sent" ? "#4ade80" : "#60a5fa" }}
          >
            <span style={styles.logTime}>{e.timestamp}</span>
            <span style={{ color: e.direction === "sent" ? "#4ade80" : "#60a5fa", marginRight: 6 }}>
              {e.direction === "sent" ? "▶" : "◀"}
            </span>
            <span style={styles.logMethod}>
              {"method" in e.message ? e.message.method : `id=${(e.message as { id: number }).id}`}
            </span>
            <pre style={styles.logBody}>{JSON.stringify(e.message, null, 2)}</pre>
          </div>
        ))}
      </div>
    </div>
  );
}

function RealtimeLogPanel({
  entries,
}: {
  entries: Array<{ id: number; direction: "client" | "server" | "meta"; timestamp: string; label: string; body: string }>;
}) {
  return (
    <div style={styles.panel}>
      <div style={styles.panelHeader}>OpenAI Realtime Log</div>
      <div style={styles.scrollArea}>
        {entries.length === 0 && (
          <div style={{ color: "#6b7280", padding: "8px 12px", fontSize: 13 }}>No OpenAI Realtime events yet.</div>
        )}
        {entries.map((entry) => (
          <div
            key={entry.id}
            style={{
              ...styles.logEntry,
              borderLeftColor:
                entry.direction === "client" ? "#22c55e" : entry.direction === "server" ? "#38bdf8" : "#f59e0b",
            }}
          >
            <span style={styles.logTime}>{entry.timestamp}</span>
            <span style={styles.logMethod}>{entry.label}</span>
            <pre style={styles.logBody}>{entry.body}</pre>
          </div>
        ))}
      </div>
    </div>
  );
}

function RealtimeConversationPanel({
  messages,
}: {
  messages: Array<{
    id: string;
    role: "user" | "assistant";
    text: string;
    status: "streaming" | "complete";
    source: "voice" | "text" | "voice-pending";
    timestamp: string;
  }>;
}) {
  return (
    <div style={styles.panel}>
      <div style={styles.panelHeader}>Realtime Conversation</div>
      <div style={styles.scrollArea}>
        {messages.length === 0 && (
          <div style={{ color: "#6b7280", padding: "8px 12px", fontSize: 13 }}>No conversation messages yet.</div>
        )}
        {messages.map((message) => (
          <div
            key={message.id}
            style={{
              ...styles.messageBubble,
              marginLeft: message.role === "assistant" ? 8 : 48,
              marginRight: message.role === "assistant" ? 48 : 8,
              borderLeftColor: message.role === "assistant" ? "#38bdf8" : "#22c55e",
            }}
          >
            <div style={styles.messageMeta}>
              <span>{message.role === "assistant" ? "Assistant" : "User"}</span>
              <span>{message.source}</span>
              <span>{message.status}</span>
              <span>{message.timestamp}</span>
            </div>
            <div style={styles.messageText}>{message.text || "..."}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function EventPanel({ events }: { events: AgentEvent[] }) {
  const filtered = events.filter((e) => e.method && AGENT_METHODS_OF_INTEREST.has(e.method));

  return (
    <div style={styles.panel}>
      <div style={styles.panelHeader}>Agent Activity</div>
      <div style={styles.scrollArea}>
        {filtered.length === 0 && (
          <div style={{ color: "#6b7280", padding: "8px 12px", fontSize: 13 }}>No agent events yet.</div>
        )}
        {filtered.map((e) => (
          <div key={e.id} style={styles.eventEntry}>
            <span style={styles.logTime}>{e.timestamp}</span>
            <span style={eventMethodColor(e.method ?? "")}>{e.method}</span>
            <div style={{ color: "#d1d5db", fontSize: 12, marginTop: 2, paddingLeft: 4 }}>{e.summary}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function eventMethodColor(method: string): React.CSSProperties {
  if (method.startsWith("turn/")) return { color: "#f59e0b", fontWeight: 600, fontSize: 12 };
  if (method.startsWith("item/fileChange")) return { color: "#a78bfa", fontWeight: 600, fontSize: 12 };
  if (method.startsWith("item/commandExecution")) return { color: "#f87171", fontWeight: 600, fontSize: 12 };
  if (method.startsWith("item/agentMessage")) return { color: "#34d399", fontWeight: 600, fontSize: 12 };
  if (method === "thread/realtime/sdp") return { color: "#38bdf8", fontWeight: 600, fontSize: 12 };
  return { color: "#9ca3af", fontWeight: 600, fontSize: 12 };
}

function pickDefaultModel(models: ModelInfo[]) {
  const realtimeCandidate = models.find((model) => model.id.toLowerCase().includes("realtime"));
  return realtimeCandidate?.id ?? models[0]?.id ?? "codex-mini-latest";
}

export default function App() {
  const [wsUrl, setWsUrl] = useState(`ws://localhost:3001?target=ws://127.0.0.1:3000`);
  const [cwd, setCwd] = useState("/tmp");
  const [selectedModel, setSelectedModel] = useState("codex-mini-latest");
  const [realtimeModel, setRealtimeModel] = useState("gpt-realtime");
  const [realtimeVoice, setRealtimeVoice] = useState("marin");
  const [realtimeInstructions, setRealtimeInstructions] = useState(
    "You are a helpful voice coding assistant. Speak only in English unless the user explicitly asks for another language. Keep answers concise and wait until the user finishes speaking before replying.",
  );
  const [realtimeText, setRealtimeText] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [authError, setAuthError] = useState<string | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  const {
    status,
    log,
    agentEvents,
    thread,
    models,
    account,
    connect,
    disconnect,
    send,
    startThread,
    listModels,
    readAccount,
    loginWithApiKey,
    logout,
  } = useCodexWebSocket();
  const {
    status: realtimeStatus,
    error: realtimeError,
    logs: realtimeLogs,
    messages: realtimeMessages,
    isMicMuted,
    connect: connectRealtime,
    disconnect: disconnectRealtime,
    sendText: sendRealtimeText,
    toggleMicMuted,
  } = useOpenAIRealtime();

  const sdpHandlerRef = useRef<((sdp: string) => void) | null>(null);

  const onSdpNotification = useCallback((handler: (sdp: string) => void) => {
    sdpHandlerRef.current = handler;
    return () => {
      sdpHandlerRef.current = null;
    };
  }, []);

  // Fire SDP handler when we receive thread/realtime/sdp notifications
  const prevEventCount = useRef(0);
  if (agentEvents.length !== prevEventCount.current) {
    prevEventCount.current = agentEvents.length;
    const last = agentEvents[agentEvents.length - 1];
    if (last?.method === "thread/realtime/sdp" && sdpHandlerRef.current) {
      const sdp = (last.raw as Record<string, unknown>)?.sdp as string;
      if (sdp) sdpHandlerRef.current(sdp);
    }
  }

  const { voiceStatus, error: voiceError, startVoice, stopVoice } = useVoiceSession({
    send: send as (method: string, params?: unknown) => Promise<unknown>,
    threadId: thread?.id ?? "",
    onSdpNotification,
  });

  const [threadError, setThreadError] = useState<string | null>(null);

  useEffect(() => {
    if (models.length === 0) return;
    if (!models.some((model) => model.id === selectedModel)) {
      setSelectedModel(pickDefaultModel(models));
    }
  }, [models, selectedModel]);

  const handleConnect = () => connect(wsUrl);

  const handleApiKeyLogin = async () => {
    const trimmed = apiKey.trim();
    if (!trimmed) {
      setAuthError("Enter an OpenAI API key first.");
      return;
    }
    setAuthBusy(true);
    setAuthError(null);
    try {
      await loginWithApiKey(trimmed);
    } catch (e) {
      setAuthError((e as Error).message);
    } finally {
      setAuthBusy(false);
    }
  };

  const handleLogout = async () => {
    setAuthBusy(true);
    setAuthError(null);
    try {
      await logout();
    } catch (e) {
      setAuthError((e as Error).message);
    } finally {
      setAuthBusy(false);
    }
  };

  const handleStartThread = async () => {
    setThreadError(null);
    try {
      await startThread(cwd, selectedModel);
    } catch (e) {
      setThreadError((e as Error).message);
    }
  };

  const handleStartRealtime = async () => {
    await connectRealtime({
      model: realtimeModel,
      voice: realtimeVoice,
      instructions: realtimeInstructions,
    });
  };

  const handleSendRealtimeText = () => {
    const text = realtimeText.trim();
    if (!text) return;
    try {
      sendRealtimeText(text);
      setRealtimeText("");
    } catch (e) {
      console.error(e);
    }
  };

  const statusDot = { disconnected: "#6b7280", connecting: "#f59e0b", connected: "#4ade80", error: "#f87171" }[status];
  const realtimeStatusDot = voiceStatusColor(realtimeStatus);

  return (
    <div style={styles.root}>
      <div style={styles.header}>
        <h1 style={styles.title}>Voice Codex</h1>
        <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span
            style={{ width: 10, height: 10, borderRadius: "50%", background: statusDot, display: "inline-block" }}
          />
          <span style={{ color: "#9ca3af", fontSize: 13 }}>{status}</span>
        </span>
      </div>

      <div style={styles.controls}>
        <div style={styles.sectionCard}>
          <div style={styles.sectionHeader}>
            <div>
              <div style={styles.sectionTitle}>OpenAI Realtime</div>
              <div style={styles.helpText}>
                Direct voice-to-voice lane over OpenAI Realtime API. This keeps the Codex app-server path intact for later.
              </div>
            </div>
            <span style={{ ...styles.accountBadge, borderColor: realtimeStatusDot, color: "#e2e8f0" }}>
              Realtime: <strong style={{ color: realtimeStatusDot }}>{realtimeStatus}</strong>
            </span>
          </div>

          <div style={styles.row}>
            <select style={styles.input} value={realtimeModel} onChange={(e) => setRealtimeModel(e.target.value)}>
              <option value="gpt-realtime">gpt-realtime</option>
              <option value="gpt-realtime-mini">gpt-realtime-mini</option>
              <option value="gpt-realtime-1.5">gpt-realtime-1.5</option>
              <option value="gpt-4o-realtime-preview">gpt-4o-realtime-preview</option>
            </select>
            <select style={styles.input} value={realtimeVoice} onChange={(e) => setRealtimeVoice(e.target.value)}>
              <option value="alloy">alloy</option>
              <option value="ash">ash</option>
              <option value="ballad">ballad</option>
              <option value="coral">coral</option>
              <option value="echo">echo</option>
              <option value="marin">marin</option>
              <option value="sage">sage</option>
              <option value="shimmer">shimmer</option>
              <option value="verse">verse</option>
            </select>
            {realtimeStatus === "active" || realtimeStatus === "connecting" || realtimeStatus === "requesting-mic" ? (
              <>
                <button
                  style={{ ...styles.btn, background: isMicMuted ? "#b45309" : "#475569" }}
                  onClick={toggleMicMuted}
                  disabled={realtimeStatus !== "active"}
                >
                  {isMicMuted ? "Unmute Mic" : "Mute Mic"}
                </button>
                <button style={{ ...styles.btn, background: "#7f1d1d" }} onClick={() => disconnectRealtime()}>
                  Stop Realtime
                </button>
              </>
            ) : (
              <button style={styles.btn} onClick={() => void handleStartRealtime()}>
                Start Realtime Voice
              </button>
            )}
          </div>

          <textarea
            style={styles.textarea}
            value={realtimeInstructions}
            onChange={(e) => setRealtimeInstructions(e.target.value)}
            placeholder="Realtime instructions"
          />

          <div style={styles.row}>
            <input
              style={styles.input}
              value={realtimeText}
              onChange={(e) => setRealtimeText(e.target.value)}
              placeholder="Optional: send text to the realtime session"
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleSendRealtimeText();
                }
              }}
            />
            <button
              style={{ ...styles.btn, background: "#475569" }}
              onClick={handleSendRealtimeText}
              disabled={realtimeStatus !== "active"}
            >
              Send Text
            </button>
          </div>

          <div style={styles.helpText}>
            Requires <code>OPENAI_API_KEY</code> in the shell that started <code>pnpm dev</code>. The browser sends SDP to a
            local Vite endpoint, and that endpoint creates the OpenAI Realtime call using your server-side key.
          </div>
          <div style={styles.helpText}>
            You can mute the mic after the session starts and keep using <code>Send Text</code> without room noise
            triggering turns.
          </div>

          {realtimeError && <div style={styles.errorMsg}>{realtimeError}</div>}
        </div>

        <div style={styles.sectionCard}>
          <div style={styles.sectionHeader}>
            <div>
              <div style={styles.sectionTitle}>Codex App Server</div>
              <div style={styles.helpText}>Preserved for local Codex threads, activity logs, and later hookup from voice to coding.</div>
            </div>
          </div>

        <div style={styles.row}>
          <input
            style={styles.input}
            value={wsUrl}
            onChange={(e) => setWsUrl(e.target.value)}
            placeholder="ws://localhost:3000"
          />
          {status === "disconnected" || status === "error" ? (
            <button style={styles.btn} onClick={handleConnect}>
              Connect
            </button>
          ) : (
            <button style={{ ...styles.btn, background: "#374151" }} onClick={disconnect}>
              Disconnect
            </button>
          )}
        </div>

        {status === "connected" && (
          <>
            <div style={styles.accountRow}>
              <span style={styles.accountBadge}>
                Auth: <strong>{account?.type ?? "unknown"}</strong>
              </span>
              {account?.email && <span style={styles.accountMeta}>{account.email}</span>}
              {account?.orgName && <span style={styles.accountMeta}>{account.orgName}</span>}
              <button style={{ ...styles.btn, background: "#475569" }} onClick={() => void readAccount()}>
                Refresh Account
              </button>
              <button style={{ ...styles.btn, background: "#7f1d1d" }} onClick={() => void handleLogout()} disabled={authBusy}>
                Logout
              </button>
            </div>
            <div style={styles.row}>
              <input
                style={styles.input}
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="OpenAI API key for account/login/start"
              />
              <button style={styles.btn} onClick={() => void handleApiKeyLogin()} disabled={authBusy}>
                {authBusy ? "Working..." : "Use API Key"}
              </button>
            </div>
            <div style={styles.helpText}>
              This logs the current app-server session into API-key mode via <code>account/login/start</code>.
            </div>
          </>
        )}

        {status === "connected" && !thread && (
          <>
            <div style={styles.row}>
              <select style={styles.input} value={selectedModel} onChange={(e) => setSelectedModel(e.target.value)}>
                {models.length === 0 ? (
                  <option value={selectedModel}>{selectedModel}</option>
                ) : (
                  models.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.id}
                    </option>
                  ))
                )}
              </select>
              <button style={{ ...styles.btn, background: "#475569" }} onClick={() => void listModels()}>
                Refresh Models
              </button>
            </div>
            <div style={styles.helpText}>
              {models.some((model) => model.id.toLowerCase().includes("realtime"))
                ? "A realtime-looking model was found. If voice still fails, start a new thread with a different model."
                : "No obvious realtime model was listed by app-server. Voice may stay unavailable on the current Codex install."}
            </div>
            <div style={styles.row}>
              <input
                style={styles.input}
                value={cwd}
                onChange={(e) => setCwd(e.target.value)}
                placeholder="Working directory (cwd)"
              />
              <button style={styles.btn} onClick={handleStartThread}>
                Start Thread
              </button>
            </div>
          </>
        )}

        {authError && <div style={styles.errorMsg}>{authError}</div>}
        {threadError && <div style={styles.errorMsg}>{threadError}</div>}

        {thread && (
          <div style={styles.threadInfo}>
            <span style={{ color: "#9ca3af", fontSize: 12 }}>Thread: </span>
            <span style={{ color: "#60a5fa", fontSize: 12, fontFamily: "monospace" }}>{thread.id}</span>
            <span style={{ color: "#9ca3af", fontSize: 12, marginLeft: 12 }}>Voice: </span>
            <span style={{ color: voiceStatusColor(voiceStatus), fontSize: 12 }}>{voiceStatus}</span>
            <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
              {voiceStatus === "idle" || voiceStatus === "error" ? (
                <button style={styles.btnVoice} onClick={startVoice}>
                  🎙 Start Voice Session
                </button>
              ) : (
                <button style={{ ...styles.btnVoice, background: "#7f1d1d" }} onClick={stopVoice}>
                  ⏹ Stop Voice
                </button>
              )}
            </div>
          </div>
        )}

        {voiceError && <div style={styles.errorMsg}>{voiceError}</div>}
        </div>
      </div>

      <div style={styles.panels}>
        <RealtimeConversationPanel messages={realtimeMessages} />
        <RealtimeLogPanel entries={realtimeLogs} />
        <EventPanel events={agentEvents} />
        <LogPanel entries={log} />
      </div>
    </div>
  );
}

function voiceStatusColor(s: string) {
  if (s === "active") return "#4ade80";
  if (s === "error") return "#f87171";
  if (s === "connecting" || s === "requesting-mic") return "#f59e0b";
  return "#9ca3af";
}

const styles: Record<string, React.CSSProperties> = {
  root: {
    minHeight: "100vh",
    background: "#0f172a",
    color: "#f1f5f9",
    display: "flex",
    flexDirection: "column",
    fontFamily: "'Inter', system-ui, sans-serif",
    padding: "0 0 24px 0",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "16px 24px",
    borderBottom: "1px solid #1e293b",
  },
  title: { margin: 0, fontSize: 20, fontWeight: 700, color: "#f1f5f9" },
  controls: {
    padding: "16px 24px",
    display: "flex",
    flexDirection: "column",
    gap: 16,
    borderBottom: "1px solid #1e293b",
  },
  sectionCard: {
    display: "flex",
    flexDirection: "column",
    gap: 10,
    background: "#111827",
    border: "1px solid #1f2937",
    borderRadius: 10,
    padding: 14,
  },
  sectionHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: 12,
    flexWrap: "wrap",
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: 700,
    color: "#f8fafc",
  },
  row: { display: "flex", gap: 8, alignItems: "center" },
  input: {
    flex: 1,
    background: "#1e293b",
    border: "1px solid #334155",
    borderRadius: 6,
    color: "#f1f5f9",
    padding: "7px 12px",
    fontSize: 13,
    fontFamily: "monospace",
    outline: "none",
  },
  textarea: {
    minHeight: 88,
    resize: "vertical",
    background: "#1e293b",
    border: "1px solid #334155",
    borderRadius: 6,
    color: "#f1f5f9",
    padding: "10px 12px",
    fontSize: 13,
    fontFamily: "inherit",
    outline: "none",
  },
  btn: {
    background: "#2563eb",
    color: "#fff",
    border: "none",
    borderRadius: 6,
    padding: "7px 16px",
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  btnVoice: {
    background: "#059669",
    color: "#fff",
    border: "none",
    borderRadius: 6,
    padding: "6px 14px",
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
  },
  threadInfo: {
    display: "flex",
    alignItems: "center",
    gap: 4,
    background: "#1e293b",
    borderRadius: 6,
    padding: "8px 12px",
  },
  panels: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
    gap: 16,
    padding: "16px 24px",
    flex: 1,
    minHeight: 0,
  },
  panel: {
    background: "#1e293b",
    borderRadius: 8,
    border: "1px solid #334155",
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    minHeight: 400,
    maxHeight: "calc(100vh - 280px)",
  },
  panelHeader: {
    padding: "8px 12px",
    fontSize: 12,
    fontWeight: 700,
    color: "#64748b",
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    borderBottom: "1px solid #334155",
    background: "#0f172a",
  },
  scrollArea: { flex: 1, overflowY: "auto", padding: "4px 0" },
  logEntry: {
    borderLeft: "3px solid",
    margin: "2px 8px",
    padding: "4px 8px",
    borderRadius: "0 4px 4px 0",
    background: "#0f172a",
  },
  logTime: { color: "#475569", fontSize: 11, fontFamily: "monospace", marginRight: 6 },
  logMethod: { color: "#94a3b8", fontSize: 12, fontFamily: "monospace", fontWeight: 600 },
  logBody: {
    margin: "2px 0 0 0",
    fontSize: 11,
    color: "#64748b",
    whiteSpace: "pre-wrap",
    wordBreak: "break-all",
    maxHeight: 120,
    overflow: "hidden",
    fontFamily: "monospace",
  },
  eventEntry: {
    margin: "2px 8px",
    padding: "5px 8px",
    background: "#0f172a",
    borderRadius: 4,
    borderLeft: "3px solid #334155",
  },
  errorMsg: {
    color: "#fca5a5",
    fontSize: 12,
    background: "#450a0a",
    borderRadius: 4,
    padding: "6px 10px",
  },
  helpText: {
    color: "#94a3b8",
    fontSize: 12,
    lineHeight: 1.4,
  },
  accountRow: {
    display: "flex",
    gap: 8,
    alignItems: "center",
    flexWrap: "wrap",
  },
  accountBadge: {
    color: "#e2e8f0",
    background: "#1e293b",
    border: "1px solid #334155",
    borderRadius: 999,
    padding: "6px 10px",
    fontSize: 12,
  },
  accountMeta: {
    color: "#94a3b8",
    fontSize: 12,
  },
  messageBubble: {
    margin: "8px",
    padding: "10px 12px",
    background: "#0f172a",
    borderRadius: 8,
    borderLeft: "3px solid",
  },
  messageMeta: {
    display: "flex",
    gap: 8,
    flexWrap: "wrap",
    color: "#64748b",
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: "0.03em",
    marginBottom: 6,
  },
  messageText: {
    color: "#e2e8f0",
    fontSize: 13,
    lineHeight: 1.5,
    whiteSpace: "pre-wrap",
  },
};
