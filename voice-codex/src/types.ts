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
  segmentId?: string | null;
}

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";
export type CodexSegmentMode = "start" | "steer" | "interrupt";
export type CodexSegmentState = "idle" | "running" | "waiting_for_user" | "completed" | "failed";
export type CodexRelayState = "not_spoken" | "progress_spoken" | "clarification_spoken" | "completion_spoken";

export interface CodexMessage {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  status: "streaming" | "final";
  timestamp: string;
  eventKind?: "start" | "steer" | "interrupt";
  turnId?: string | null;
  segmentId?: string | null;
}

export interface CodexSegment {
  id: string;
  sourceUtterance: string;
  mode: CodexSegmentMode;
  codexState: CodexSegmentState;
  relayState: CodexRelayState;
  createdAt: string;
  updatedAt: string;
  turnId?: string | null;
  latestMilestone: string | null;
  blockingQuestion: string | null;
  finalOutcome: string | null;
  filesRead: string[];
  filesEdited: string[];
  commandsRun: string[];
}

declare global {
  interface Window {
    IDEBridge?: {
      projectPath?: string;
      openFile: (path: string) => void;
    };
  }
}
