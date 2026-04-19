import { useCallback, useEffect, useRef, useState } from "react";
import type { JsonRpcMessage, LogEntry, AgentEvent, ConnectionStatus, Thread, ModelInfo, AccountInfo, CodexMessage } from "./types";
import { CODEX_PROJECT_CWD, CODEX_MODEL, CODEX_REASONING_EFFORT } from "./codexConfig";

let nextId = 1;

function nowTime() {
  return new Date().toISOString().slice(11, 19);
}

function summarizeCommandLabel(item: Record<string, unknown>) {
  const command = String(item.command ?? "").trim();
  if (!command) return "Running Codex command";
  return `Running: ${command}`.slice(0, 160);
}

function summarizeCommandResult(item: Record<string, unknown>) {
  const command = String(item.command ?? "").trim();
  const exitCode = typeof item.exitCode === "number" ? item.exitCode : null;
  const durationMs = typeof item.durationMs === "number" ? item.durationMs : null;
  const duration = durationMs !== null ? ` in ${(durationMs / 1000).toFixed(durationMs >= 1000 ? 1 : 0)}s` : "";

  if (!command) {
    return exitCode === null ? "Command finished" : `Command finished with exit code ${exitCode}${duration}`;
  }

  if (exitCode === 0) return `Completed: ${command}${duration}`.slice(0, 160);
  if (exitCode === null) return `Completed: ${command}`.slice(0, 160);
  return `Failed (${exitCode}): ${command}${duration}`.slice(0, 160);
}

function summarizePlanUpdate(params: unknown) {
  const plan = ((params as { plan?: Array<{ step?: string; status?: string }> })?.plan ?? []).filter(Boolean);
  if (plan.length === 0) return "Updated plan";

  const parts = plan.map((item) => {
    const status = item.status ?? "pending";
    const marker = status === "completed" ? "done" : status === "in_progress" ? "doing" : "next";
    return `${marker}: ${item.step ?? "Unnamed step"}`;
  });

  return `Plan update\n${parts.join("\n")}`.slice(0, 600);
}

function summarizeEvent(method: string, params: unknown): string {
  const p = params as Record<string, unknown>;
  if (!p) return method;

  if (method === "item/started" || method === "item/completed") {
    const item = p.item as Record<string, unknown>;
    if (item) return `${method}: [${item.type}] ${item.command ?? item.text ?? item.query ?? ""}`.slice(0, 120);
  }
  if (method.startsWith("item/") && method.endsWith("delta")) {
    return `${method}: "${String(p.delta ?? "").slice(0, 60)}"`;
  }
  if (method === "turn/started" || method === "turn/completed") {
    const turn = p.turn as Record<string, unknown>;
    return `${method}: status=${turn?.status ?? "?"}`;
  }
  if (method === "thread/realtime/sdp") {
    return `thread/realtime/sdp: received answer SDP`;
  }
  if (method === "account/updated") {
    return `account/updated: authMode=${(p as Record<string, unknown>).authMode ?? "?"}`;
  }
  return method;
}

export function useCodexWebSocket() {
  const [status, setStatus] = useState<ConnectionStatus>("disconnected");
  const [log, setLog] = useState<LogEntry[]>([]);
  const [agentEvents, setAgentEvents] = useState<AgentEvent[]>([]);
  const [thread, setThread] = useState<Thread | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [account, setAccount] = useState<AccountInfo | null>(null);
  const [codexMessages, setCodexMessages] = useState<CodexMessage[]>([]);
  const [activeTurnStatus, setActiveTurnStatus] = useState<"idle" | "running" | "error">("idle");
  const [activeTurnId, setActiveTurnId] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const pendingRef = useRef<Map<number, { resolve: (msg: JsonRpcMessage) => void; reject: (error: Error) => void }>>(
    new Map(),
  );
  const logIdRef = useRef(0);
  const assistantMessageIdByItemRef = useRef<Map<string, string>>(new Map());
  const progressMessageIdByItemRef = useRef<Map<string, string>>(new Map());

  const appendCodexMessage = useCallback((message: CodexMessage) => {
    setCodexMessages((prev) => [...prev, message]);
  }, []);

  const upsertCodexMessage = useCallback((message: CodexMessage) => {
    setCodexMessages((prev) => {
      const existingIndex = prev.findIndex((entry) => entry.id === message.id);
      if (existingIndex === -1) return [...prev, message];

      const next = [...prev];
      next[existingIndex] = { ...next[existingIndex], ...message };
      return next;
    });
  }, []);

  const addLog = useCallback((direction: "sent" | "received", message: JsonRpcMessage) => {
    setLog((prev) => [
      ...prev,
      {
        id: ++logIdRef.current,
        direction,
        timestamp: new Date().toISOString().slice(11, 23),
        message,
      },
    ]);
  }, []);

  const addAgentEvent = useCallback((method: string, params: unknown) => {
    setAgentEvents((prev) => [
      ...prev,
      {
        id: String(++logIdRef.current),
        type: method.split("/")[0],
        method,
        summary: summarizeEvent(method, params),
        raw: params,
        timestamp: new Date().toISOString().slice(11, 23),
      },
    ]);
  }, []);

  const send = useCallback((method: string, params?: unknown): Promise<JsonRpcMessage> => {
    return new Promise((resolve, reject) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        reject(new Error("WebSocket not connected"));
        return;
      }
      const id = nextId++;
      const msg = { jsonrpc: "2.0" as const, method, id, params };
      pendingRef.current.set(id, { resolve, reject });
      addLog("sent", msg);
      ws.send(JSON.stringify(msg));
      // timeout after 30s
      setTimeout(() => {
        if (pendingRef.current.has(id)) {
          pendingRef.current.delete(id);
          reject(new Error(`Timeout waiting for response to ${method} (id=${id})`));
        }
      }, 30000);
    });
  }, [addLog]);

  const listModels = useCallback(async (): Promise<ModelInfo[]> => {
    const resp = await send("model/list", { includeHidden: false });
    const data = (resp as { result?: { data?: ModelInfo[] } }).result?.data ?? [];
    setModels(data);
    return data;
  }, [send]);

  const readAccount = useCallback(async (): Promise<AccountInfo | null> => {
    const resp = await send("account/read", { refreshToken: false });
    const accountData = (resp as { result?: { account?: AccountInfo | null } }).result?.account ?? null;
    setAccount(accountData);
    return accountData;
  }, [send]);

  const loginWithApiKey = useCallback(async (apiKey: string): Promise<void> => {
    await send("account/login/start", { type: "apiKey", apiKey });
    await readAccount();
    await listModels();
  }, [send, readAccount, listModels]);

  const logout = useCallback(async (): Promise<void> => {
    await send("account/logout");
    setAccount(null);
    setModels([]);
    setThread(null);
    await readAccount();
    await listModels().catch(() => {});
  }, [send, readAccount, listModels]);

  const connect = useCallback((url: string) => {
    if (wsRef.current) {
      wsRef.current.close();
    }
    setStatus("connecting");
    setLog([]);
    setAgentEvents([]);
    setThread(null);
    setModels([]);
    setAccount(null);
    setCodexMessages([]);
    setActiveTurnStatus("idle");
    setActiveTurnId(null);
    assistantMessageIdByItemRef.current.clear();
    progressMessageIdByItemRef.current.clear();

    const ws = new WebSocket(url);
    wsRef.current = ws;

    const initId = nextId++;

    ws.onopen = () => {
      setStatus("connected");
      const msg = {
        jsonrpc: "2.0" as const,
        method: "initialize",
        id: initId,
        params: {
          clientInfo: { name: "voice-codex", title: "Voice Codex", version: "0.1.0" },
          capabilities: { experimentalApi: true },
        },
      };
      addLog("sent", msg);
      ws.send(JSON.stringify(msg));
    };

    ws.onmessage = (ev) => {
      let parsed: JsonRpcMessage;
      try {
        parsed = JSON.parse(ev.data as string) as JsonRpcMessage;
      } catch {
        return;
      }
      addLog("received", parsed);

      // It's a response (has id, no method)
      if ("id" in parsed && !("method" in parsed)) {
        const id = (parsed as { id: number }).id;

        // After initialize response, send the required "initialized" notification
        if (id === initId) {
          const notif = { jsonrpc: "2.0" as const, method: "initialized", params: {} };
          addLog("sent", notif);
          ws.send(JSON.stringify(notif));
          void listModels().catch(() => {});
          void readAccount().catch(() => {});
        }

        if ("error" in parsed) {
          const err = (parsed as { error: { message?: string; code?: number } }).error;
          const pending = pendingRef.current.get(id);
          if (pending) {
            pendingRef.current.delete(id);
            pending.reject(new Error(err.message ?? `JSON-RPC error ${err.code ?? "unknown"}`));
          }
          return;
        }

        const pending = pendingRef.current.get(id);
        if (pending) {
          pendingRef.current.delete(id);
          pending.resolve(parsed);
        }
        return;
      }

      // It's a notification or server-initiated request
      const method = (parsed as { method: string }).method;
      const params = (parsed as { params?: unknown }).params;

      if (method === "turn/started") {
        const turn = (params as { turn?: { id?: string } })?.turn;
        setActiveTurnStatus("running");
        setActiveTurnId(turn?.id ?? null);
      }

      if (method === "turn/completed") {
        const turn = (params as { turn?: { status?: string; error?: { message?: string } } })?.turn;
        setActiveTurnStatus(turn?.status === "failed" ? "error" : "idle");
        setActiveTurnId(null);
        const errorMessage = turn?.error?.message;
        if (turn?.status === "failed" && errorMessage) {
          appendCodexMessage({
            id: `assistant-error-${Date.now()}`,
            role: "assistant",
            text: `Turn failed: ${errorMessage}`,
            status: "final",
            timestamp: nowTime(),
          });
        }
      }

      if (method === "turn/plan/updated") {
        appendCodexMessage({
          id: `plan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          role: "assistant",
          text: summarizePlanUpdate(params),
          status: "final",
          timestamp: nowTime(),
        });
      }

      if (method === "item/started") {
        const item = (params as { item?: Record<string, unknown> })?.item;
        if (item?.type === "agentMessage") {
          const itemId = String(item.id ?? `assistant-${Date.now()}`);
          assistantMessageIdByItemRef.current.set(itemId, itemId);
          appendCodexMessage({
            id: itemId,
            role: "assistant",
            text: "",
            status: "streaming",
            timestamp: nowTime(),
          });
        }

        if (item?.type === "commandExecution") {
          const itemId = String(item.id ?? `command-${Date.now()}`);
          const progressId = `progress-${itemId}`;
          progressMessageIdByItemRef.current.set(itemId, progressId);
          appendCodexMessage({
            id: progressId,
            role: "assistant",
            text: summarizeCommandLabel(item),
            status: "streaming",
            timestamp: nowTime(),
          });
        }
      }

      if (method === "item/agentMessage/delta") {
        const p = params as Record<string, unknown>;
        const itemId = String(p.itemId ?? p.item_id ?? p.id ?? "");
        const delta = String(p.delta ?? "");
        if (itemId && delta) {
          const targetId = assistantMessageIdByItemRef.current.get(itemId) ?? itemId;
          assistantMessageIdByItemRef.current.set(itemId, targetId);
          setCodexMessages((prev) => {
            const existing = prev.find((message) => message.id === targetId);
            if (existing) {
              return prev.map((message) =>
                message.id === targetId ? { ...message, text: `${message.text}${delta}`, status: "streaming" } : message,
              );
            }
            return [
              ...prev,
              {
                id: targetId,
                role: "assistant",
                text: delta,
                status: "streaming",
                timestamp: nowTime(),
              },
            ];
          });
        }
      }

      if (method === "item/completed") {
        const item = (params as { item?: Record<string, unknown> })?.item;
        if (item?.type === "agentMessage") {
          const itemId = String(item.id ?? "");
          const targetId = assistantMessageIdByItemRef.current.get(itemId) ?? itemId;
          const text = Array.isArray(item.content)
            ? (item.content as Array<Record<string, unknown>>)
                .map((part) => String(part.text ?? ""))
                .join("")
            : "";
          if (targetId) {
            setCodexMessages((prev) =>
              prev.map((message) =>
                message.id === targetId
                  ? { ...message, text: text || message.text, status: "final" }
                  : message,
              ),
            );
          }
        }

        if (item?.type === "commandExecution") {
          const itemId = String(item.id ?? "");
          const progressId = progressMessageIdByItemRef.current.get(itemId);
          if (progressId) {
            upsertCodexMessage({
              id: progressId,
              role: "assistant",
              text: summarizeCommandResult(item),
              status: "final",
              timestamp: nowTime(),
            });
            progressMessageIdByItemRef.current.delete(itemId);
          }
        }
      }

      addAgentEvent(method, params);
    };

    ws.onerror = () => setStatus("error");
    ws.onclose = () => {
      setStatus("disconnected");
      wsRef.current = null;
    };
  }, [addLog, addAgentEvent, appendCodexMessage, listModels, readAccount, upsertCodexMessage]);

  const disconnect = useCallback(() => {
    wsRef.current?.close();
  }, []);

  const startThread = useCallback(async (_cwd: string, _model: string): Promise<Thread> => {
    const resp = await send("thread/start", {
      model: CODEX_MODEL,
      cwd: CODEX_PROJECT_CWD,
      config: {
        model_reasoning_effort: CODEX_REASONING_EFFORT,
      },
      approvalPolicy: "never",
      sandbox: "workspace-write",
      sessionStartSource: "startup",
    });
    const result = (resp as { result: { thread: Thread } }).result;
    setThread(result.thread);
    return result.thread;
  }, [send]);

  const startTurn = useCallback(async (threadId: string, text: string): Promise<void> => {
    const trimmed = text.trim();
    if (!trimmed) throw new Error("Task text is empty");
    appendCodexMessage({
      id: `user-${Date.now()}`,
      role: "user",
      text: trimmed,
      status: "final",
      timestamp: nowTime(),
    });
    setActiveTurnStatus("running");
    const resp = await send("turn/start", {
      threadId,
      input: [{ type: "text", text: trimmed }],
    });
    const turnId = (resp as { result?: { turn?: { id?: string } } }).result?.turn?.id;
    if (turnId) {
      setActiveTurnId(turnId);
    }
  }, [appendCodexMessage, send]);

  const steerTurn = useCallback(async (threadId: string, text: string): Promise<void> => {
    const trimmed = text.trim();
    if (!trimmed) throw new Error("Steering text is empty");
    if (!activeTurnId) throw new Error("No active Codex turn to steer");
    appendCodexMessage({
      id: `user-steer-${Date.now()}`,
      role: "user",
      text: trimmed,
      status: "final",
      timestamp: nowTime(),
    });
    await send("turn/steer", {
      threadId,
      input: [{ type: "text", text: trimmed }],
      expectedTurnId: activeTurnId,
    });
  }, [activeTurnId, appendCodexMessage, send]);

  const interruptTurn = useCallback(async (threadId: string): Promise<void> => {
    if (!activeTurnId) throw new Error("No active Codex turn to interrupt");
    await send("turn/interrupt", {
      threadId,
      turnId: activeTurnId,
    });
  }, [activeTurnId, send]);

  useEffect(() => {
    return () => {
      const ws = wsRef.current;
      if (ws) {
        wsRef.current = null;
        ws.close();
      }
    };
  }, []);

  return {
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
    codexMessages,
    activeTurnStatus,
    activeTurnId,
    startTurn,
    steerTurn,
    interruptTurn,
    wsRef,
  };
}
