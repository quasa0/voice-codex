import { useCallback, useEffect, useRef, useState } from "react";
import type {
  JsonRpcMessage,
  LogEntry,
  AgentEvent,
  ConnectionStatus,
  Thread,
  ModelInfo,
  AccountInfo,
  CodexMessage,
  CodexMessageKind,
  CodexSegment,
  CodexSegmentActivityKind,
  CodexRelayState,
  CodexSegmentMode,
} from "./types";
import { CODEX_MODEL, CODEX_REASONING_EFFORT, getCodexProjectCwd } from "./codexConfig";

let nextId = 1;

function nowTime() {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 2,
    hour12: false,
  }).format(new Date());
}

function nowMs() {
  return Date.now();
}

function newActivityId() {
  return `activity-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function appendSegmentActivity(
  activities: CodexSegment["activities"],
  kind: CodexSegmentActivityKind,
  summary: string,
) {
  return [
    ...activities,
    {
      id: newActivityId(),
      kind,
      summary,
      timestamp: nowTime(),
    },
  ].slice(-12);
}

function newSegmentId() {
  return `segment-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function truncateLine(text: string, maxLength = 220) {
  const singleLine = text.trim().split("\n").find(Boolean) ?? text.trim();
  return singleLine.slice(0, maxLength) || null;
}

type IdeFocusTarget = {
  path: string;
  lineStart?: number;
  lineEnd?: number;
};

type SerializedFocusTarget = {
  target: string;
  openedAt: number;
};

function trimWrappedQuotes(value: string) {
  return value.replace(/^['"]|['"]$/g, "");
}

function joinProjectPath(basePath: string, candidate: string) {
  if (!candidate) return null;
  if (candidate.startsWith("/")) return candidate;
  return `${basePath.replace(/\/$/, "")}/${candidate.replace(/^\.\//, "")}`;
}

function isCodexProgressMessage(text: string) {
  const trimmed = text.trim();
  if (!trimmed) return true;
  return (
    trimmed.startsWith("Plan update") ||
    trimmed.startsWith("Completed:") ||
    trimmed.startsWith("Running:") ||
    trimmed.startsWith("Failed (") ||
    trimmed.startsWith("Turn failed:")
  );
}

function messageLooksLikeStructuredOutput(text: string) {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("```") || trimmed.includes("\n```")) return true;

  const nonEmptyLines = trimmed.split("\n").map((line) => line.trim()).filter(Boolean);
  if (nonEmptyLines.length < 4) return false;

  const structuredLineCount = nonEmptyLines.filter((line) =>
    /^(?:#|[-*]|\d+\.|`{1,3}|[A-Za-z0-9_.-]+[\\/][A-Za-z0-9_.-]+|[A-Za-z0-9_.-]+\s*$)/.test(line),
  ).length;
  return structuredLineCount >= Math.ceil(nonEmptyLines.length * 0.6);
}

function messageRequestsUserInput(text: string) {
  const trimmed = text.trim();
  if (!trimmed || isCodexProgressMessage(trimmed)) return false;
  if (messageLooksLikeStructuredOutput(trimmed)) return false;
  if (inferRunningAssistantKind(trimmed)) return false;
  if (trimmed.includes("?")) return true;

  const lowered = trimmed.toLowerCase();
  return [
    "could you clarify",
    "can you clarify",
    "please clarify",
    "need clarity",
    "need more direction",
    "need more detail",
    "need a constraint",
    "need constraint",
    "which ",
    "what kind",
    "what would you like",
    "what do you want",
    "pick one",
    "pick a ",
    "pick any",
    "choose one",
    "choose a ",
    "send me",
    "reply with",
    "use this format",
    "give me these",
    "give me the",
    "start with",
    "let me know if",
    "if you want me to",
  ].some((phrase) => lowered.includes(phrase));
}

function inferRunningAssistantKind(text: string): Exclude<CodexSegmentActivityKind, "reply" | "error"> | null {
  const lowered = text.trim().toLowerCase();
  if (!lowered || isCodexProgressMessage(lowered)) return null;

  if (
    /\b(patch|patching|edit|editing|update|updating|replace|replacing|change|changing|modify|modifying|write|writing|wire|wiring|implement|implementing|apply|applying)\b/.test(lowered)
  ) {
    return "edit";
  }

  if (
    /\b(read|reading|inspect|inspecting|check|checking|scan|scanning|look(?:ing)?(?:\s+at|\s+into)?|trace|tracing|pull(?:ing)?|review|reviewing)\b/.test(lowered)
  ) {
    return "read";
  }

  if (
    /\b(plan|planning|next step|next steps|going to|i'll|i will|after that|then i'll|then i will)\b/.test(lowered)
  ) {
    return "plan";
  }

  return null;
}

function parseCommandContext(command: string) {
  const trimmed = command.trim();
  const cdPrefix = trimmed.match(/^cd\s+(['"]?)([^'"]+)\1\s*&&\s*(.+)$/);
  if (!cdPrefix) {
    return { workingDirectory: "", innerCommand: trimmed };
  }

  return {
    workingDirectory: trimWrappedQuotes(cdPrefix[2]?.trim() ?? ""),
    innerCommand: cdPrefix[3]?.trim() ?? "",
  };
}

function extractTouchedPath(command: string) {
  const { workingDirectory, innerCommand } = parseCommandContext(command);
  const match = innerCommand.match(/(?:cat|nl -ba|sed -n '[^']+')\s+(['"]?)([^'"\n]+)\1/);
  if (!match) return null;
  const rawPath = trimWrappedQuotes(match[2]?.trim() ?? "");
  if (!rawPath) return null;
  const normalized = workingDirectory && !rawPath.startsWith("/")
    ? `${workingDirectory.replace(/\/$/, "")}/${rawPath.replace(/^\.\//, "")}`
    : rawPath;
  const segments = normalized.split("/").filter(Boolean);
  return segments.slice(-2).join("/") || normalized;
}

function extractCommandFilePath(command: string) {
  const projectCwd = getCodexProjectCwd();
  const { workingDirectory, innerCommand } = parseCommandContext(command);
  const match = innerCommand.match(/(?:cat|nl -ba|sed -n '[^']+')\s+(['"]?)([^'"\n]+)\1/);
  if (!match) return null;
  const rawPath = trimWrappedQuotes(match[2]?.trim() ?? "");
  if (!rawPath) return null;
  return joinProjectPath(
    projectCwd,
    workingDirectory && !rawPath.startsWith("/")
      ? `${workingDirectory.replace(/\/$/, "")}/${rawPath.replace(/^\.\//, "")}`
      : rawPath,
  );
}

function extractCommandLineRange(command: string): { lineStart?: number; lineEnd?: number } | null {
  const { innerCommand } = parseCommandContext(command);
  const sedMatch = innerCommand.match(/sed -n '(\d+)(?:,(\d+))?p'/);
  if (!sedMatch) return null;

  const lineStart = Number.parseInt(sedMatch[1] ?? "", 10);
  const lineEnd = Number.parseInt(sedMatch[2] ?? sedMatch[1] ?? "", 10);
  if (!Number.isFinite(lineStart) || !Number.isFinite(lineEnd)) return null;
  return { lineStart, lineEnd };
}

function classifyCommandKind(command: string): CodexMessageKind {
  const { innerCommand } = parseCommandContext(command);
  if (/(?:cat|nl -ba|sed -n '[^']+'|rg\s)/.test(innerCommand)) {
    return "read";
  }
  return "command";
}

function extractEditedPath(item: Record<string, unknown>) {
  const pathCandidate = [
    item.path,
    item.filePath,
    item.targetPath,
    item.relativePath,
    item.uri,
  ].find((value) => typeof value === "string" && value.trim());
  if (typeof pathCandidate !== "string") return null;
  const normalized = pathCandidate.trim();
  const segments = normalized.split("/").filter(Boolean);
  return segments.slice(-2).join("/") || normalized;
}

function extractEditedAbsolutePath(item: Record<string, unknown>) {
  const projectCwd = getCodexProjectCwd();
  const pathCandidate = [
    item.path,
    item.filePath,
    item.targetPath,
    item.relativePath,
    item.uri,
    (item.file as Record<string, unknown> | undefined)?.path,
    (item.file as Record<string, unknown> | undefined)?.filePath,
    (item.change as Record<string, unknown> | undefined)?.path,
    (item.change as Record<string, unknown> | undefined)?.filePath,
    ((item.changes as Array<Record<string, unknown>> | undefined)?.[0])?.path,
    ((item.changes as Array<Record<string, unknown>> | undefined)?.[0])?.filePath,
    ((item.edits as Array<Record<string, unknown>> | undefined)?.[0])?.path,
    ((item.edits as Array<Record<string, unknown>> | undefined)?.[0])?.filePath,
  ].find((value) => typeof value === "string" && value.trim());
  if (typeof pathCandidate === "string") {
    const normalized = trimWrappedQuotes(pathCandidate.trim());
    return joinProjectPath(projectCwd, normalized);
  }

  const patchText = String(item.patch ?? item.diff ?? item.unifiedDiff ?? item.output ?? item.summary ?? item.description ?? "");
  const patchPathMatch =
    patchText.match(/^\+\+\+\s+b\/([^\n]+)/m) ??
    patchText.match(/^---\s+a\/([^\n]+)/m) ??
    patchText.match(/^\*\*\*\s+Update File:\s+([^\n]+)/m) ??
    patchText.match(/^\*\*\*\s+Add File:\s+([^\n]+)/m) ??
    patchText.match(/(?:^|\n)M\s+([^\n]+)/m);
  if (!patchPathMatch?.[1]) return null;
  return joinProjectPath(projectCwd, trimWrappedQuotes(patchPathMatch[1].trim()));
}

function parseLineNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(1, Math.floor(value));
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed)) return Math.max(1, parsed);
  }
  return undefined;
}

function extractPatchLineRange(text: string | null | undefined): { lineStart?: number; lineEnd?: number } | null {
  if (!text) return null;
  const hunkMatch = text.match(/@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
  if (!hunkMatch) return null;

  const lineStart = parseLineNumber(hunkMatch[1]);
  const lineCount = parseLineNumber(hunkMatch[2] ?? "1") ?? 1;
  if (!lineStart) return null;
  return {
    lineStart,
    lineEnd: Math.max(lineStart, lineStart + Math.max(1, lineCount) - 1),
  };
}

function extractFileChangeLineRange(item: Record<string, unknown>): { lineStart?: number; lineEnd?: number } | null {
  const directStart = parseLineNumber(
    item.lineStart ?? item.startLine ?? item.line ?? item.lineNumber ?? item.start ?? item.start_line,
  );
  const directEnd = parseLineNumber(
    item.lineEnd ?? item.endLine ?? item.end ?? item.end_line,
  );
  if (directStart || directEnd) {
    return {
      lineStart: directStart ?? directEnd,
      lineEnd: directEnd ?? directStart,
    };
  }

  const range = item.range as Record<string, unknown> | undefined;
  const nestedStart = parseLineNumber(
    range?.lineStart ?? range?.startLine ?? (range?.start as Record<string, unknown> | undefined)?.line,
  );
  const nestedEnd = parseLineNumber(
    range?.lineEnd ?? range?.endLine ?? (range?.end as Record<string, unknown> | undefined)?.line,
  );
  if (nestedStart || nestedEnd) {
    return {
      lineStart: nestedStart ?? nestedEnd,
      lineEnd: nestedEnd ?? nestedStart,
    };
  }

  return extractPatchLineRange(
    String(item.patch ?? item.diff ?? item.unifiedDiff ?? item.output ?? item.summary ?? item.description ?? ""),
  );
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

function getEventTurnId(params: unknown): string | null {
  const record = params as { turnId?: unknown; turn?: { id?: unknown } } | undefined;
  const direct = record?.turnId;
  if (typeof direct === "string" && direct.trim()) return direct;
  const nested = record?.turn?.id;
  if (typeof nested === "string" && nested.trim()) return nested;
  return null;
}

interface UseCodexWebSocketOptions {
  initialLog?: LogEntry[];
  initialAgentEvents?: AgentEvent[];
  initialCodexMessages?: CodexMessage[];
  initialSegments?: CodexSegment[];
}

export function useCodexWebSocket(options: UseCodexWebSocketOptions = {}) {
  const [status, setStatus] = useState<ConnectionStatus>("disconnected");
  const [log, setLog] = useState<LogEntry[]>(() => options.initialLog ?? []);
  const [agentEvents, setAgentEvents] = useState<AgentEvent[]>(() => options.initialAgentEvents ?? []);
  const [thread, setThread] = useState<Thread | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [account, setAccount] = useState<AccountInfo | null>(null);
  const [codexMessages, setCodexMessages] = useState<CodexMessage[]>(() => options.initialCodexMessages ?? []);
  const [activeTurnStatus, setActiveTurnStatus] = useState<"idle" | "running" | "error">("idle");
  const [activeTurnId, setActiveTurnId] = useState<string | null>(null);
  const [segments, setSegments] = useState<CodexSegment[]>(() => options.initialSegments ?? []);

  const wsRef = useRef<WebSocket | null>(null);
  const pendingRef = useRef<Map<number, { resolve: (msg: JsonRpcMessage) => void; reject: (error: Error) => void }>>(
    new Map(),
  );
  const logIdRef = useRef(0);
  const assistantMessageIdByItemRef = useRef<Map<string, string>>(new Map());
  const progressMessageIdByItemRef = useRef<Map<string, string>>(new Map());
  const turnSegmentIdRef = useRef<Map<string, string>>(new Map());
  const pendingNextTurnSegmentIdRef = useRef<string | null>(null);
  const activeSegmentIdRef = useRef<string | null>(null);
  const activeTurnStatusRef = useRef<"idle" | "running" | "error">("idle");
  const activeTurnIdRef = useRef<string | null>(null);
  const codexMessagesRef = useRef<CodexMessage[]>([]);
  const lastIdeOpenedTargetRef = useRef<SerializedFocusTarget | null>(null);

  useEffect(() => {
    codexMessagesRef.current = codexMessages;
  }, [codexMessages]);

  useEffect(() => {
    activeTurnStatusRef.current = activeTurnStatus;
  }, [activeTurnStatus]);

  useEffect(() => {
    activeTurnIdRef.current = activeTurnId;
  }, [activeTurnId]);

  const openFileInIde = useCallback((target: IdeFocusTarget | null | undefined) => {
    const normalizedPath = target?.path?.trim();
    if (!normalizedPath || typeof window === "undefined") return;
    const focusTarget = target as IdeFocusTarget;

    const serializedTarget = JSON.stringify({
      path: normalizedPath,
      lineStart: focusTarget.lineStart ?? null,
      lineEnd: focusTarget.lineEnd ?? null,
    });
    const now = Date.now();
    if (
      lastIdeOpenedTargetRef.current?.target === serializedTarget &&
      now - lastIdeOpenedTargetRef.current.openedAt < 350
    ) {
      return;
    }
    lastIdeOpenedTargetRef.current = { target: serializedTarget, openedAt: now };

    if (window.IDEBridge?.focusFile) {
      window.IDEBridge.focusFile({
        path: normalizedPath,
        lineStart: focusTarget.lineStart,
        lineEnd: focusTarget.lineEnd,
      });
      return;
    }

    window.IDEBridge?.openFile?.(normalizedPath);
  }, []);

  const updateSegment = useCallback((segmentId: string | null | undefined, updater: (segment: CodexSegment) => CodexSegment) => {
    if (!segmentId) return;
    setSegments((prev) =>
      prev.map((segment) =>
        segment.id === segmentId
          ? {
              ...updater(segment),
              updatedAt: nowTime(),
              updatedAtMs: nowMs(),
            }
          : segment,
      ),
    );
  }, []);

  const beginSegment = useCallback((mode: CodexSegmentMode, sourceUtterance: string) => {
    const createdAt = nowTime();
    const createdAtMs = nowMs();
    const segmentId = newSegmentId();
    const segment: CodexSegment = {
      id: segmentId,
      sourceUtterance: sourceUtterance.trim(),
      mode,
      codexState: "running",
      relayState: "not_spoken",
      createdAt,
      createdAtMs,
      updatedAt: createdAt,
      updatedAtMs: createdAtMs,
      turnId: mode === "steer" ? activeTurnId : null,
      latestMilestone: null,
      blockingQuestion: null,
      finalOutcome: null,
      filesRead: [],
      filesEdited: [],
      commandsRun: [],
      activities: [],
      lastUserCheckInAt: null,
      lastRelayedActivityIndex: -1,
      lastRelayedStatusSummary: null,
    };

    activeSegmentIdRef.current = segmentId;
    if (mode !== "steer") {
      pendingNextTurnSegmentIdRef.current = segmentId;
    } else if (activeTurnId) {
      turnSegmentIdRef.current.set(activeTurnId, segmentId);
    }

    setSegments((prev) => [...prev, segment]);
    setCodexMessages((prev) => [
      ...prev,
      {
        id: `system-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        role: "system",
        text: mode === "start" ? "new turn" : mode,
        status: "final",
        timestamp: createdAt,
        eventKind: mode,
        segmentId,
      },
    ]);

    return segmentId;
  }, [activeTurnId]);

  const bindSegmentToTurn = useCallback((segmentId: string | null | undefined, turnId: string | null | undefined) => {
    if (!segmentId || !turnId) return;
    turnSegmentIdRef.current.set(turnId, segmentId);
    pendingNextTurnSegmentIdRef.current = pendingNextTurnSegmentIdRef.current === segmentId ? null : pendingNextTurnSegmentIdRef.current;
    activeSegmentIdRef.current = segmentId;
    updateSegment(segmentId, (segment) => ({
      ...segment,
      turnId,
      codexState: "running",
    }));
  }, [updateSegment]);

  const resolveSegmentId = useCallback((turnId?: string | null) => {
    if (turnId) {
      const mapped = turnSegmentIdRef.current.get(turnId);
      if (mapped) return mapped;
    }
    return pendingNextTurnSegmentIdRef.current ?? activeSegmentIdRef.current;
  }, []);

  const noteSegmentCommand = useCallback((segmentId: string | null | undefined, item: Record<string, unknown>) => {
    if (!segmentId) return;
    const command = String(item.command ?? "").trim();
    const touchedPath = extractTouchedPath(command);
    const idePath = extractCommandFilePath(command);
    const commandLineRange = extractCommandLineRange(command);
    const commandKind = classifyCommandKind(command);
    const commandSummary = summarizeCommandLabel(item);
    openFileInIde(idePath ? { path: idePath, ...commandLineRange } : null);
    updateSegment(segmentId, (segment) => ({
      ...segment,
      codexState: "running",
      latestMilestone: commandSummary,
      commandsRun: command && !segment.commandsRun.includes(command)
        ? [...segment.commandsRun, command].slice(-8)
        : segment.commandsRun,
      filesRead: touchedPath && !segment.filesRead.includes(touchedPath)
        ? [...segment.filesRead, touchedPath].slice(-8)
        : segment.filesRead,
      activities: appendSegmentActivity(segment.activities, commandKind, commandSummary),
    }));
  }, [openFileInIde, updateSegment]);

  const noteSegmentMessage = useCallback((segmentId: string | null | undefined, text: string, status: "streaming" | "final") => {
    if (!segmentId) return;
    const firstLine = truncateLine(text);
    updateSegment(segmentId, (segment) => {
      const requestsInput = status === "final" && messageRequestsUserInput(text);
      const isFinalSubstantiveAnswer = status === "final" && !requestsInput && !isCodexProgressMessage(text) && text.trim().length > 0;
      const sameTurnStillRunning =
        activeTurnStatusRef.current === "running" &&
        (!segment.turnId || segment.turnId === activeTurnIdRef.current);
      const inferredProgressKind =
        status === "final" && sameTurnStillRunning && isFinalSubstantiveAnswer
          ? inferRunningAssistantKind(text)
          : null;
      const blockingQuestion = requestsInput ? text.trim() : isFinalSubstantiveAnswer ? null : segment.blockingQuestion;
      const finalOutcome = isFinalSubstantiveAnswer && !sameTurnStillRunning ? text.trim() : segment.finalOutcome;

      return {
        ...segment,
        codexState:
          requestsInput
            ? "waiting_for_user"
            : isFinalSubstantiveAnswer
              ? sameTurnStillRunning
                ? "running"
                : "completed"
              : segment.codexState === "waiting_for_user" && status === "streaming"
                ? "running"
                : segment.codexState,
        latestMilestone: status === "final" ? firstLine ?? segment.latestMilestone : segment.latestMilestone,
        blockingQuestion,
        finalOutcome,
        activities:
          status === "final" && firstLine
            ? appendSegmentActivity(segment.activities, inferredProgressKind ?? "reply", firstLine)
            : segment.activities,
      };
    });
  }, [updateSegment]);

  const noteSegmentPlan = useCallback((segmentId: string | null | undefined, summary: string) => {
    updateSegment(segmentId, (segment) => ({
      ...segment,
      codexState: "running",
      latestMilestone: truncateLine(summary) ?? segment.latestMilestone,
      activities: appendSegmentActivity(segment.activities, "plan", truncateLine(summary) ?? summary),
    }));
  }, [updateSegment]);

  const noteSegmentFileChange = useCallback((segmentId: string | null | undefined, item: Record<string, unknown>) => {
    if (!segmentId) return;
    const editedPath = extractEditedPath(item);
    const absoluteEditedPath = extractEditedAbsolutePath(item) ?? (editedPath ? joinProjectPath(getCodexProjectCwd(), editedPath) : null);
    const fileChangeLineRange = extractFileChangeLineRange(item);
    openFileInIde(absoluteEditedPath ? { path: absoluteEditedPath, ...fileChangeLineRange } : null);
    const milestone = truncateLine(String(item.summary ?? item.description ?? "Updated files"));
    updateSegment(segmentId, (segment) => ({
      ...segment,
      codexState: "running",
      latestMilestone: milestone ?? segment.latestMilestone,
      filesEdited: editedPath && !segment.filesEdited.includes(editedPath)
        ? [...segment.filesEdited, editedPath].slice(-8)
        : segment.filesEdited,
      activities: appendSegmentActivity(segment.activities, "edit", milestone ?? (editedPath ? `Updated ${editedPath}` : "Updated files")),
    }));
  }, [openFileInIde, updateSegment]);

  const setSegmentRelayState = useCallback((segmentId: string, relayState: CodexRelayState) => {
    updateSegment(segmentId, (segment) => ({ ...segment, relayState }));
  }, [updateSegment]);

  const appendCodexMessage = useCallback((message: CodexMessage) => {
    setCodexMessages((prev) => [...prev, message]);
  }, []);

  const appendStreamingProgressMessage = useCallback(
    (itemId: string, delta: string, turnId: string | null, fallbackPrefix = "Streaming output", segmentId?: string | null) => {
      if (!itemId || !delta) return;
      const progressId = progressMessageIdByItemRef.current.get(itemId) ?? `progress-${itemId}`;
      progressMessageIdByItemRef.current.set(itemId, progressId);

      setCodexMessages((prev) => {
        const existing = prev.find((message) => message.id === progressId);
        if (existing) {
          return prev.map((message) =>
            message.id === progressId
              ? {
                  ...message,
                  text: `${message.text}${delta}`,
                  status: "streaming",
                  turnId: message.turnId ?? turnId,
                  segmentId: message.segmentId ?? segmentId ?? null,
                }
              : message,
          );
        }

        return [
          ...prev,
          {
            id: progressId,
            role: "assistant",
            text: `${fallbackPrefix}\n${delta}`,
            status: "streaming",
            timestamp: nowTime(),
            turnId,
            segmentId: segmentId ?? null,
          },
        ];
      });
    },
    [],
  );

  const addSystemMessage = useCallback((text: string, eventKind?: CodexMessage["eventKind"]) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    appendCodexMessage({
      id: `system-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      role: "system",
      text: trimmed,
      status: "final",
      timestamp: nowTime(),
      eventKind,
      segmentId: activeSegmentIdRef.current,
    });
  }, [appendCodexMessage]);

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
        timestamp: nowTime(),
        message,
      },
    ]);
  }, []);

  const addAgentEvent = useCallback((method: string, params: unknown, segmentId?: string | null) => {
    setAgentEvents((prev) => [
      ...prev,
      {
        id: String(++logIdRef.current),
        type: method.split("/")[0],
        method,
        summary: summarizeEvent(method, params),
        raw: params,
        timestamp: nowTime(),
        segmentId: segmentId ?? null,
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

  const connect = useCallback((url: string, preserveHistory = false) => {
    if (wsRef.current) {
      wsRef.current.close();
    }
    setStatus("connecting");
    if (!preserveHistory) {
      setLog([]);
      setAgentEvents([]);
      setCodexMessages([]);
      setSegments([]);
    }
    setThread(null);
    setModels([]);
    setAccount(null);
    setActiveTurnStatus("idle");
    setActiveTurnId(null);
    assistantMessageIdByItemRef.current.clear();
    progressMessageIdByItemRef.current.clear();
    turnSegmentIdRef.current.clear();
    pendingNextTurnSegmentIdRef.current = null;
    activeSegmentIdRef.current = null;

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
      const turnId = getEventTurnId(params);
      let segmentId = resolveSegmentId(turnId);

      if (method === "turn/started") {
        const turn = (params as { turn?: { id?: string } })?.turn;
        activeTurnStatusRef.current = "running";
        activeTurnIdRef.current = turn?.id ?? null;
        setActiveTurnStatus("running");
        setActiveTurnId(turn?.id ?? null);
        segmentId = segmentId ?? pendingNextTurnSegmentIdRef.current;
        bindSegmentToTurn(segmentId, turn?.id ?? null);
      }

      if (method === "turn/completed") {
        const turn = (params as { turn?: { status?: string; error?: { message?: string } } })?.turn;
        segmentId = resolveSegmentId(turnId);
        activeTurnStatusRef.current = turn?.status === "failed" ? "error" : "idle";
        activeTurnIdRef.current = null;
        setActiveTurnStatus(turn?.status === "failed" ? "error" : "idle");
        setActiveTurnId(null);
        const errorMessage = turn?.error?.message;
        updateSegment(segmentId, (segment) => ({
          ...segment,
          codexState:
            turn?.status === "failed"
              ? "failed"
              : segment.blockingQuestion
                ? "waiting_for_user"
                : "completed",
          latestMilestone:
            turn?.status === "failed"
              ? truncateLine(`Turn failed: ${errorMessage ?? "Unknown error"}`)
              : segment.latestMilestone,
          finalOutcome:
            turn?.status === "failed" && errorMessage
              ? `Turn failed: ${errorMessage}`
              : segment.finalOutcome,
          activities:
            turn?.status === "failed" && errorMessage
              ? appendSegmentActivity(segment.activities, "error", `Turn failed: ${errorMessage}`)
              : segment.activities,
        }));
        if (turn?.status === "failed" && errorMessage) {
          appendCodexMessage({
            id: `assistant-error-${Date.now()}`,
            role: "assistant",
            text: `Turn failed: ${errorMessage}`,
            status: "final",
            timestamp: nowTime(),
            kind: "error",
            turnId,
            segmentId: segmentId ?? null,
          });
        }
      }

      if (method === "turn/plan/updated") {
        segmentId = resolveSegmentId(turnId);
        const summary = summarizePlanUpdate(params);
        noteSegmentPlan(segmentId, summary);
        appendCodexMessage({
          id: `plan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          role: "assistant",
          text: summary,
          status: "final",
          timestamp: nowTime(),
          kind: "plan",
          turnId,
          segmentId: segmentId ?? null,
        });
      }

      if (method === "item/started") {
        const item = (params as { item?: Record<string, unknown> })?.item;
        segmentId = resolveSegmentId(turnId);
        if (item?.type === "agentMessage") {
          const itemId = String(item.id ?? `assistant-${Date.now()}`);
          assistantMessageIdByItemRef.current.set(itemId, itemId);
          appendCodexMessage({
            id: itemId,
            role: "assistant",
            text: "",
            status: "streaming",
            timestamp: nowTime(),
            kind: "reply",
            turnId,
            segmentId: segmentId ?? null,
          });
        }

        if (item?.type === "commandExecution") {
          const itemId = String(item.id ?? `command-${Date.now()}`);
          const progressId = `progress-${itemId}`;
          progressMessageIdByItemRef.current.set(itemId, progressId);
          noteSegmentCommand(segmentId, item);
          appendCodexMessage({
            id: progressId,
            role: "assistant",
            text: summarizeCommandLabel(item),
            status: "streaming",
            timestamp: nowTime(),
            kind: classifyCommandKind(String(item.command ?? "")),
            turnId,
            segmentId: segmentId ?? null,
          });
        }
      }

      if (method === "item/agentMessage/delta") {
        const p = params as Record<string, unknown>;
        const itemId = String(p.itemId ?? p.item_id ?? p.id ?? "");
        const delta = String(p.delta ?? "");
        segmentId = resolveSegmentId(turnId);
        if (itemId && delta) {
          const targetId = assistantMessageIdByItemRef.current.get(itemId) ?? itemId;
          assistantMessageIdByItemRef.current.set(itemId, targetId);
          noteSegmentMessage(segmentId, delta, "streaming");
          setCodexMessages((prev) => {
            const existing = prev.find((message) => message.id === targetId);
            if (existing) {
              return prev.map((message) =>
                message.id === targetId
                  ? {
                      ...message,
                      text: `${message.text}${delta}`,
                      status: "streaming",
                      kind: message.kind ?? "reply",
                      segmentId: message.segmentId ?? segmentId ?? null,
                    }
                  : message,
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
                kind: "reply",
                turnId,
                segmentId: segmentId ?? null,
              },
            ];
          });
        }
      }

      if (method === "item/commandExecution/outputDelta") {
        segmentId = resolveSegmentId(turnId);
      }

      if (method === "item/fileChange/outputDelta") {
        segmentId = resolveSegmentId(turnId);
      }

      if (method === "item/completed") {
        const item = (params as { item?: Record<string, unknown> })?.item;
        segmentId = resolveSegmentId(turnId);
        if (item?.type === "agentMessage") {
          const itemId = String(item.id ?? "");
          const targetId = assistantMessageIdByItemRef.current.get(itemId) ?? itemId;
          const textFromContent = Array.isArray(item.content)
            ? (item.content as Array<Record<string, unknown>>)
                .map((part) => String(part.text ?? ""))
                .join("")
            : "";
          const existingMessage = codexMessagesRef.current.find((message) => message.id === targetId);
          const resolvedText = textFromContent || existingMessage?.text || "";
          noteSegmentMessage(segmentId, resolvedText, "final");
          if (targetId) {
            setCodexMessages((prev) =>
              prev.map((message) =>
                message.id === targetId
                  ? {
                      ...message,
                      text: resolvedText || message.text,
                      status: "final",
                      kind: message.kind ?? "reply",
                      turnId: message.turnId ?? turnId,
                      segmentId: message.segmentId ?? segmentId ?? null,
                    }
                  : message,
              ),
            );
          }
        }

        if (item?.type === "commandExecution") {
          const itemId = String(item.id ?? "");
          const progressId = progressMessageIdByItemRef.current.get(itemId);
          noteSegmentCommand(segmentId, item);
          if (progressId) {
            upsertCodexMessage({
              id: progressId,
              role: "assistant",
              text: summarizeCommandResult(item),
              status: "final",
              timestamp: nowTime(),
              kind: classifyCommandKind(String(item.command ?? "")),
              turnId,
              segmentId: segmentId ?? null,
            });
            progressMessageIdByItemRef.current.delete(itemId);
          }
        }

        if (item?.type === "fileChange") {
          noteSegmentFileChange(segmentId, item);
          const editedPath = extractEditedPath(item);
          appendCodexMessage({
            id: `file-change-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            role: "assistant",
            text: editedPath ? `Updated ${editedPath}` : "Updated files",
            status: "final",
            timestamp: nowTime(),
            kind: "edit",
            turnId,
            segmentId: segmentId ?? null,
          });
        }
      }

      addAgentEvent(method, params, segmentId);
    };

    ws.onerror = () => setStatus("error");
    ws.onclose = () => {
      setStatus("disconnected");
      wsRef.current = null;
    };
  }, [addLog, addAgentEvent, appendCodexMessage, appendStreamingProgressMessage, listModels, readAccount, upsertCodexMessage]);

  const disconnect = useCallback(() => {
    wsRef.current?.close();
  }, []);

  const startThread = useCallback(async (cwd?: string, model?: string): Promise<Thread> => {
    void cwd;
    void model;
    const resp = await send("thread/start", {
      model: CODEX_MODEL,
      cwd: getCodexProjectCwd(),
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

  const startTurn = useCallback(async (
    threadId: string,
    text: string,
    segmentId?: string,
    displayText?: string,
  ): Promise<void> => {
    const trimmed = text.trim();
    const visibleText = (displayText ?? text).trim();
    if (!trimmed) throw new Error("Task text is empty");
    const activeSegmentId = segmentId ?? beginSegment("start", visibleText || trimmed);
    pendingNextTurnSegmentIdRef.current = activeSegmentId;
    activeSegmentIdRef.current = activeSegmentId;
    appendCodexMessage({
      id: `user-${Date.now()}`,
      role: "user",
      text: visibleText || trimmed,
      status: "final",
      timestamp: nowTime(),
      segmentId: activeSegmentId,
    });
    activeTurnStatusRef.current = "running";
    setActiveTurnStatus("running");
    const resp = await send("turn/start", {
      threadId,
      input: [{ type: "text", text: trimmed }],
    });
    const turnId = (resp as { result?: { turn?: { id?: string } } }).result?.turn?.id;
    if (turnId) {
      activeTurnIdRef.current = turnId;
      setActiveTurnId(turnId);
      bindSegmentToTurn(activeSegmentId, turnId);
    }
  }, [appendCodexMessage, beginSegment, bindSegmentToTurn, send]);

  const steerTurn = useCallback(async (
    threadId: string,
    text: string,
    segmentId?: string,
    displayText?: string,
  ): Promise<void> => {
    const trimmed = text.trim();
    const visibleText = (displayText ?? text).trim();
    if (!trimmed) throw new Error("Steering text is empty");
    if (!activeTurnId) throw new Error("No active Codex turn to steer");
    const activeSegmentId = segmentId ?? beginSegment("steer", visibleText || trimmed);
    bindSegmentToTurn(activeSegmentId, activeTurnId);
    appendCodexMessage({
      id: `user-steer-${Date.now()}`,
      role: "user",
      text: visibleText || trimmed,
      status: "final",
      timestamp: nowTime(),
      turnId: activeTurnId,
      segmentId: activeSegmentId,
    });
    await send("turn/steer", {
      threadId,
      input: [{ type: "text", text: trimmed }],
      expectedTurnId: activeTurnId,
    });
  }, [activeTurnId, appendCodexMessage, beginSegment, bindSegmentToTurn, send]);

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
    segments,
    activeTurnStatus,
    activeTurnId,
    startTurn,
    steerTurn,
    interruptTurn,
    beginSegment,
    updateSegment,
    setSegmentRelayState,
    addSystemMessage,
    wsRef,
  };
}
