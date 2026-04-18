import { useCallback, useEffect, useRef, useState } from "react";
import type { JsonRpcMessage, LogEntry, AgentEvent, ConnectionStatus, Thread, ModelInfo, AccountInfo } from "./types";

let nextId = 1;

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

  const wsRef = useRef<WebSocket | null>(null);
  const pendingRef = useRef<Map<number, { resolve: (msg: JsonRpcMessage) => void; reject: (error: Error) => void }>>(
    new Map(),
  );
  const logIdRef = useRef(0);

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

      addAgentEvent(method, params);
    };

    ws.onerror = () => setStatus("error");
    ws.onclose = () => {
      setStatus("disconnected");
      wsRef.current = null;
    };
  }, [addLog, addAgentEvent, listModels, readAccount]);

  const disconnect = useCallback(() => {
    wsRef.current?.close();
  }, []);

  const startThread = useCallback(async (cwd: string, model: string): Promise<Thread> => {
    const resp = await send("thread/start", {
      model,
      cwd,
      approvalPolicy: "never",
      sandbox: "workspace-write",
      sessionStartSource: "startup",
    });
    const result = (resp as { result: { thread: Thread } }).result;
    setThread(result.thread);
    return result.thread;
  }, [send]);

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
    wsRef,
  };
}
