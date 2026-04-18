export interface JsonRpcRequest {
  jsonrpc: "2.0";
  method: string;
  id: number;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

export interface Thread {
  id: string;
  preview: string;
  modelProvider: string;
  createdAt: number;
}

export interface ModelInfo {
  id: string;
  name?: string;
  hidden?: boolean;
}

export interface AccountInfo {
  type?: string;
  email?: string | null;
  orgName?: string | null;
}

export interface LogEntry {
  id: number;
  direction: "sent" | "received";
  timestamp: string;
  message: JsonRpcMessage;
}

export interface AgentEvent {
  id: string;
  type: string;
  method?: string;
  summary: string;
  raw: unknown;
  timestamp: string;
}

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";
