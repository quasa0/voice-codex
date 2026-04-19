import { useCallback, useEffect, useRef, useState } from "react";
import { Activity, Copy, Mic, MicOff, PhoneOff, Play, Radio, Send, SkipForward, TerminalSquare, Trash2 } from "lucide-react";
import { useCodexWebSocket } from "./useCodexWebSocket";
import { useOpenAIRealtime } from "./useOpenAIRealtime";
import type { OpenAIRealtimeStatus } from "./useOpenAIRealtime";
import type { LogEntry, AgentEvent, ModelInfo, CodexMessage, CodexMessageKind, CodexSegment, CodexSegmentActivity, CodexSegmentState } from "./types";
import { getCodexProjectCwd } from "./codexConfig";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";

const TERSE_AGENT_STYLE = [
  "Terse like caveman. Technical substance exact. Only fluff die.",
  "Drop: articles, filler (just/really/basically), pleasantries, hedging.",
  "Fragments OK. Short synonyms. Code unchanged.",
  "Pattern: [thing] [action] [reason]. [next step].",
  "ACTIVE EVERY RESPONSE. No revert after many turns. No filler drift.",
  "Code/commits/PRs: normal. Off: \"stop caveman\" / \"normal mode\".",
].join(" ");

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

type RealtimeLog = {
  id: number;
  direction: "client" | "server" | "meta";
  timestamp: string;
  label: string;
  body: string;
};

type RealtimeMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  status: "capturing" | "partial" | "streaming" | "final";
  source: "voice" | "text" | "voice-pending";
  timestamp: string;
  eventKind?: "start" | "steer" | "interrupt" | "interrupted" | "refreshed";
};

type CodexIntentAction = "chat_only" | "codex_start" | "codex_steer" | "codex_interrupt";
type RoutedIntent = {
  action: CodexIntentAction;
  chat_mode: "normal" | "relay_latest_codex" | "relay_codex_status";
  reason: string;
};

type DebugNote = {
  timestamp: string;
  label: string;
  detail?: string;
};

const STORAGE_KEYS = {
  realtimeMessages: "voice-codex.realtime.messages",
  realtimeLogs: "voice-codex.realtime.logs",
  codexMessages: "voice-codex.codex.messages",
  codexLog: "voice-codex.codex.log",
  codexEvents: "voice-codex.codex.events",
  codexSegments: "voice-codex.codex.segments",
  reconnectIntent: "voice-codex.reconnect.intent",
} as const;

const PERSIST_LIMITS = {
  realtimeMessages: 80,
  realtimeLogs: 120,
  codexMessages: 120,
  codexLog: 120,
  codexEvents: 120,
  codexSegments: 24,
} as const;

const REALTIME_CONNECT_INSTRUCTIONS =
  `You are voice coding assistant inside an already-open software project. Project workspace already known and connected to Codex. Do not ask user for repo name, folder, project structure, or what files exist unless truly impossible. For requests about files, codebase structure, repo contents, implementation details, or inspection, default to delegating to Codex. If the user asks to show, open, reveal, or focus a file in the IDE, use the focus_file_in_ide tool instead of only describing the file. Do not claim you already queried Codex unless frontend actually dispatched Codex work. If delegation not yet confirmed, say brief handoff like "Checking Codex now." Never make up project facts, implementation details, files, components, APIs, or what Codex built. If the answer is unclear from explicit context already provided in conversation, say you need to check Codex or ask a brief clarifying question instead of guessing. Use user only for product intent, ambiguity, or preference decisions. If user asks what you remember after a refresh, answer clearly that this is a fresh voice session and you only remember messages since reload. Speak only English unless user explicitly asks another language. Wait until user finishes speaking before replying. ${TERSE_AGENT_STYLE}`;
const PAGE_REFRESH_MARKER_LOAD_KEY = "voice-codex.realtime.page-refresh-load-id";
const PAGE_REFRESH_MARKER_REAL_MESSAGE_KEY = "voice-codex.realtime.page-refresh-real-message-id";

function formatNowLocal(fractionalSecondDigits: 0 | 1 | 2 | 3 = 2) {
  if (fractionalSecondDigits === 0) {
    return new Intl.DateTimeFormat(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).format(new Date());
  }

  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits,
    hour12: false,
  }).format(new Date());
}

type PersistedReconnectIntent = {
  shouldReconnectRealtime: boolean;
};

function buildRealtimeConnectInstructions(messages: RealtimeMessage[]) {
  const recentTranscript = messages
    .filter(
      (message) =>
        (message.role === "user" || message.role === "assistant") &&
        message.status === "final" &&
        message.text.trim(),
    )
    .slice(-12)
    .map((message) => {
      const speaker = message.role === "user" ? "User" : "Assistant";
      const text = message.text.replace(/\s+/g, " ").trim().slice(0, 220);
      return `${speaker}: ${text}`;
    });

  if (recentTranscript.length === 0) {
    return REALTIME_CONNECT_INSTRUCTIONS;
  }

  return [
    REALTIME_CONNECT_INSTRUCTIONS,
    "",
    "Page refreshed. Transcript below restored from UI history only.",
    "Use it as context. Do not greet, summarize, or answer this restore by itself.",
    "Wait for the next user turn before speaking.",
    "",
    "Recent transcript:",
    ...recentTranscript,
  ].join("\n");
}

function normalizePersistedRealtimeMessages(messages: RealtimeMessage[]) {
  return messages.map((message) => {
    if (message.role === "assistant" && message.status === "streaming") {
      return {
        ...message,
        status: "final" as const,
      };
    }

    if (message.role === "user" && (message.status === "capturing" || message.status === "partial")) {
      return {
        ...message,
        status: "final" as const,
      };
    }

    return message;
  });
}

function readStoredJson<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeStoredJson<T>(key: string, value: T) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Ignore storage quota/transient errors.
  }
}

function normalizeCodexDispatchText(text: string) {
  const trimmed = text.trim();
  if (!trimmed) return "";

  const normalized = trimmed
    .replace(/^(?:please\s+)?(?:can you|could you|would you)\s+/i, "")
    .replace(/^(?:please\s+)?ask\s+codex\s+to\s+/i, "")
    .replace(/^(?:please\s+)?ask\s+(?:it|him|the agent|the coding agent)\s+to\s+/i, "")
    .replace(/^(?:please\s+)?tell\s+codex\s+to\s+/i, "")
    .replace(/^(?:please\s+)?tell\s+(?:it|him|the agent|the coding agent)\s+to\s+/i, "")
    .replace(/^(?:please\s+)?have\s+codex\s+/i, "")
    .replace(/^(?:please\s+)?have\s+(?:it|him|the agent|the coding agent)\s+/i, "")
    .replace(/^(?:please\s+)?get\s+codex\s+to\s+/i, "")
    .replace(/^(?:please\s+)?get\s+(?:it|him|the agent|the coding agent)\s+to\s+/i, "")
    .replace(/^(?:please\s+)?make\s+codex\s+/i, "")
    .replace(/^(?:please\s+)?make\s+(?:it|him|the agent|the coding agent)\s+/i, "")
    .replace(/^(?:please\s+)?interrupt\s+codex\s+and\s+/i, "")
    .replace(/^(?:please\s+)?interrupt\s+(?:it|him|the agent|the coding agent)\s+and\s+/i, "")
    .replace(/^codex[:,]?\s+/i, "")
    .trim();

  if (!normalized) return trimmed;
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function segmentHasMeaningfulSummary(segment: CodexSegment | null) {
  if (!segment) return false;
  return Boolean(
    getSegmentFirstLine(segment.blockingQuestion) ||
    getSegmentFirstLine(segment.finalOutcome) ||
    getSegmentFirstLine(segment.latestMilestone) ||
    segment.filesRead.length ||
    segment.filesEdited.length ||
    segment.activities.length,
  );
}

function segmentLooksStale(segment: CodexSegment | null, activeTurnStatus: "idle" | "running" | "error") {
  if (!segment || segment.codexState !== "running") return false;
  if (activeTurnStatus === "running") return false;
  return Date.now() - segment.updatedAtMs > 45_000;
}

function findPreferredSegment(
  segments: CodexSegment[],
  activeTurnStatus: "idle" | "running" | "error",
) {
  const newestWaiting = [...segments]
    .reverse()
    .find((segment) => segment.codexState === "waiting_for_user" && Boolean(getSegmentFirstLine(segment.blockingQuestion)));
  if (newestWaiting) return newestWaiting;

  const newestHealthyRunning = [...segments]
    .reverse()
    .find((segment) => segment.codexState === "running" && !segmentLooksStale(segment, activeTurnStatus));
  if (newestHealthyRunning) return newestHealthyRunning;

  const newestMeaningfulTerminal = [...segments]
    .reverse()
    .find((segment) => (segment.codexState === "completed" || segment.codexState === "failed") && segmentHasMeaningfulSummary(segment));
  if (newestMeaningfulTerminal) return newestMeaningfulTerminal;

  const newestMeaningfulAny = [...segments].reverse().find((segment) => segmentHasMeaningfulSummary(segment));
  return newestMeaningfulAny ?? segments.at(-1) ?? null;
}

function findSupersedingSegment(segments: CodexSegment[], targetSegment: CodexSegment) {
  const targetIndex = segments.findIndex((segment) => segment.id === targetSegment.id);
  if (targetIndex < 0) return null;
  return segments
    .slice(targetIndex + 1)
    .find(
      (segment) =>
        segment.codexState === "waiting_for_user" ||
        segment.codexState === "completed" ||
        segment.codexState === "failed",
    ) ?? null;
}

function buildExactRealtimeMemoryReply(userMessage: string, messages: RealtimeMessage[]) {
  const normalized = userMessage.toLowerCase();
  const hasRefreshBoundary = messages.some((message) => message.role === "system" && message.eventKind === "refreshed");
  if (!hasRefreshBoundary) return null;

  const asksAboutMemory =
    normalized.includes("remember") ||
    normalized.includes("memory") ||
    normalized.includes("history") ||
    normalized.includes("first message") ||
    normalized.includes("full conversation") ||
    normalized.includes("all you remember") ||
    normalized.includes("every message") ||
    normalized.includes("what did i say");
  if (!asksAboutMemory) return null;

  return "Fresh session after refresh. I only remember messages since reload, not before it.";
}

function extractTouchedPath(command: string) {
  const match = command.match(/(?:cat|ls|nl -ba|sed -n '[^']+'|rg --files)\s+(['"]?)([^'"\n]+)\1/);
  if (!match) return null;
  const rawPath = match[2]?.trim();
  if (!rawPath) return null;
  const normalized = rawPath.replace(/^cd\s+[^&]+&&\s*/, "").trim();
  const segments = normalized.split("/").filter(Boolean);
  return segments.slice(-2).join("/") || normalized;
}

function summarizeRecentCommands(agentEvents: AgentEvent[]) {
  const recentCompleted = [...agentEvents]
    .reverse()
    .filter((event) => {
      if (event.method !== "item/completed") return false;
      const item = (event.raw as { item?: { type?: string; command?: string } })?.item;
      return item?.type === "commandExecution" && typeof item.command === "string";
    })
    .slice(0, 8);

  const paths: string[] = [];
  for (const event of recentCompleted) {
    const command = ((event.raw as { item?: { command?: string } })?.item?.command ?? "").trim();
    const path = extractTouchedPath(command);
    if (!path) continue;
    if (!paths.includes(path)) paths.push(path);
    if (paths.length >= 4) break;
  }

  if (paths.length === 0) return null;
  if (paths.length === 1) return `Read ${paths[0]}.`;
  if (paths.length === 2) return `Read ${paths[0]} and ${paths[1]}.`;
  return `Read ${paths.slice(0, -1).join(", ")}, and ${paths.at(-1)}.`;
}

function getCurrentSegment(segments: CodexSegment[]) {
  return segments.at(-1) ?? null;
}

function getSegmentMessages(codexMessages: CodexMessage[], segmentId?: string | null) {
  if (!segmentId) return [];
  return codexMessages.filter((message) => message.segmentId === segmentId);
}

function getSegmentEvents(agentEvents: AgentEvent[], segmentId?: string | null) {
  if (!segmentId) return [];
  return agentEvents.filter((event) => event.segmentId === segmentId);
}

function getActivitiesSinceCheckIn(segment: CodexSegment | null) {
  if (!segment) return [];
  if (segment.lastRelayedActivityIndex >= 0) {
    return segment.activities.slice(segment.lastRelayedActivityIndex + 1);
  }
  if (!segment.lastUserCheckInAt) {
    return segment.activities;
  }
  return segment.activities.filter((activity) => activity.timestamp > segment.lastUserCheckInAt!);
}

function getUnrelayedActivities(segment: CodexSegment | null) {
  if (!segment) return [];
  return segment.activities.slice(segment.lastRelayedActivityIndex + 1);
}

function summarizeSegmentActivitiesForSpeech(activities: CodexSegmentActivity[]) {
  const summarized = activities
    .map((activity) => {
      if (activity.kind === "read") {
        const cleaned = activity.summary.replace(/^Running:\s*/i, "").trim();
        return cleaned ? `Read step: ${cleaned}` : "Reading files.";
      }
      if (activity.kind === "edit") return activity.summary;
      if (activity.kind === "plan") return "Updated the plan.";
      if (activity.kind === "error") return activity.summary;
      return activity.summary;
    })
    .filter(Boolean);

  if (summarized.length === 0) return null;
  return summarized.join(" ").slice(0, 220);
}

function summarizeSegmentStatus(segment: CodexSegment | null, agentEvents: AgentEvent[] = []) {
  if (!segment) return "Codex is idle right now.";

  const readSummary =
    segment.filesRead.length === 0
      ? null
      : segment.filesRead.length === 1
        ? `Read ${segment.filesRead[0]}.`
        : segment.filesRead.length === 2
          ? `Read ${segment.filesRead[0]} and ${segment.filesRead[1]}.`
          : `Read ${segment.filesRead.slice(0, -1).join(", ")}, and ${segment.filesRead.at(-1)}.`;
  const editSummary =
    segment.filesEdited.length === 0
      ? null
      : segment.filesEdited.length === 1
        ? `Edited ${segment.filesEdited[0]}.`
        : `Edited ${segment.filesEdited.slice(0, 2).join(" and ")}.`;
  const latestEventSummary = summarizeRecentCommands(getSegmentEvents(agentEvents, segment.id));
  const milestone = segment.latestMilestone ? `${segment.latestMilestone}` : null;

  if (segment.codexState === "waiting_for_user") {
    return [
      "Codex is waiting for input.",
      readSummary,
      editSummary,
      segment.blockingQuestion ? `It asked: ${segment.blockingQuestion.split("\n").find(Boolean) ?? segment.blockingQuestion}` : null,
    ]
      .filter(Boolean)
      .join(" ")
      .slice(0, 420);
  }

  if (segment.codexState === "running") {
    return ["Codex is working.", milestone, editSummary, readSummary, latestEventSummary].filter(Boolean).join(" ").slice(0, 420);
  }

  if (segment.codexState === "failed") {
    return ["Codex failed.", milestone, segment.finalOutcome, editSummary, readSummary].filter(Boolean).join(" ").slice(0, 420);
  }

  if (segment.codexState === "completed") {
    return ["Codex completed the current segment.", segment.finalOutcome, editSummary, readSummary].filter(Boolean).join(" ").slice(0, 420);
  }

  return ["Codex is idle.", segment.finalOutcome, editSummary, readSummary].filter(Boolean).join(" ").slice(0, 360);
}

function getSegmentFirstLine(text: string | null | undefined) {
  if (!text) return null;
  return text.trim().split("\n").find(Boolean) ?? text.trim();
}

function buildSegmentReadEditSummary(segment: CodexSegment | null) {
  if (!segment) return null;
  const parts: string[] = [];
  if (segment.filesEdited.length > 0) {
    parts.push(
      segment.filesEdited.length === 1
        ? `Edited ${segment.filesEdited[0]}.`
        : `Edited ${segment.filesEdited.slice(0, 2).join(" and ")}.`,
    );
  } else if (segment.filesRead.length > 0) {
    parts.push(
      segment.filesRead.length === 1
        ? `Read ${segment.filesRead[0]}.`
        : segment.filesRead.length === 2
          ? `Read ${segment.filesRead[0]} and ${segment.filesRead[1]}.`
          : `Read ${segment.filesRead.slice(0, -1).join(", ")}, and ${segment.filesRead.at(-1)}.`,
    );
  }
  return parts.join(" ") || null;
}

function getLatestSegmentAssistantProgress(segmentMessages: CodexMessage[]) {
  return [...segmentMessages]
    .reverse()
    .find((message) => message.role === "assistant" && message.kind && message.kind !== "reply" && message.status === "final");
}

function getLatestCodexCommand(segment: CodexSegment | null) {
  return segment?.commandsRun.at(-1)?.trim() ?? "";
}

function latestCommandLooksLikeBuild(command: string) {
  return /\b(?:npm|pnpm|yarn)\s+(?:run\s+)?build\b/.test(command);
}

function latestCommandLooksLikeChecks(command: string) {
  return /\b(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:test|lint|check|typecheck|validate)\b/.test(command);
}

function capSpeechReply(text: string, maxLength = 80) {
  return text.slice(0, maxLength);
}

function formatActivityFileLabel(summary: string, fallback: string | undefined) {
  const fileMatch =
    summary.match(/\b(?:Read(?:ing)?|Edited|Editing|Updated)\s+([^\n.]+)/i) ??
    summary.match(/\b([A-Za-z0-9_./-]+\.[A-Za-z0-9_-]+)\b/);
  return (fileMatch?.[1] ?? fallback ?? "").trim();
}

function summarizeRunningSegmentForSpeech(
  segment: CodexSegment | null,
  segmentMessages: CodexMessage[] = [],
) {
  if (!segment) return "Codex is idle right now.";

  const latestCommand = getLatestCodexCommand(segment);
  const latestProgressMessage = getLatestSegmentAssistantProgress(segmentMessages);
  const workingLabel = getSegmentWorkingLabel(segment);
  if (workingLabel === "waiting for input...") {
    return capSpeechReply("Waiting for input.");
  }

  const latestEditActivity = [...segment.activities].reverse().find((activity) => activity.kind === "edit");
  if (latestEditActivity || latestProgressMessage?.kind === "edit") {
    const latestEditedFile = formatActivityFileLabel(latestEditActivity?.summary ?? "", segment.filesEdited.at(-1));
    return capSpeechReply(latestEditedFile ? `Editing ${latestEditedFile}.` : "Editing files.");
  }

  const latestReadActivity = [...segment.activities].reverse().find((activity) => activity.kind === "read");
  if (latestReadActivity || latestProgressMessage?.kind === "read" || workingLabel === "reading files...") {
    const latestReadFile = formatActivityFileLabel(latestReadActivity?.summary ?? "", segment.filesRead.at(-1));
    return capSpeechReply(latestReadFile ? `Reading ${latestReadFile}.` : "Reading files.");
  }

  const latestCommandActivity = [...segment.activities].reverse().find((activity) => activity.kind === "command");
  if (latestCommandActivity || workingLabel === "running checks..." || workingLabel === "running command...") {
    if (latestCommandLooksLikeBuild(latestCommand)) {
      return capSpeechReply("Running a build.");
    }
    if (latestCommandLooksLikeChecks(latestCommand)) {
      return capSpeechReply("Running checks.");
    }
    return capSpeechReply("Running a command.");
  }

  const latestPlanActivity = [...segment.activities].reverse().find((activity) => activity.kind === "plan");
  if (latestPlanActivity || latestProgressMessage?.kind === "plan") {
    return capSpeechReply("Planning next steps.");
  }

  return capSpeechReply("Working.");
}

function buildExactCodexRelayReply(
  userMessage: string,
  segment: CodexSegment | null,
  segmentMessages: CodexMessage[] = [],
  agentEvents: AgentEvent[] = [],
) {
  if (!segment) return "Codex is idle right now.";

  const normalized = userMessage.toLowerCase();
  const asksAboutQuestion =
    /\b(did|does|was|is)\b.*\b(ask|asked|question|clarify|clarification)\b/.test(normalized) ||
    normalized.includes("clarify") ||
    normalized.includes("clarification") ||
    normalized.includes("ask me something");
  const asksLastMessage =
    normalized.includes("last message") ||
    normalized.includes("last messsage") ||
    normalized.includes("last reply") ||
    normalized.includes("last response") ||
    normalized.includes("what did it say") ||
    normalized.includes("what was its last");
  const asksWhatHappened =
    normalized.includes("what happened") ||
    normalized.includes("what changed") ||
    normalized.includes("why did") ||
    normalized.includes("did it interrupt") ||
    normalized.includes("interrupt");
  const asksAboutTiming =
    normalized.includes("finish soon") ||
    normalized.includes("how long left") ||
    normalized.includes("how much longer") ||
    normalized.includes("when will it finish") ||
    normalized.includes("when's it done") ||
    normalized.includes("time left") ||
    normalized.includes("almost done");

  const latestAssistantMessage = [...segmentMessages]
    .reverse()
    .find((message) => message.role === "assistant" && message.status === "final" && message.text.trim());
  const latestAssistantLine = getSegmentFirstLine(latestAssistantMessage?.text);
  const blockingQuestion = getSegmentFirstLine(segment.blockingQuestion);
  const finalOutcome = getSegmentFirstLine(segment.finalOutcome) ?? latestAssistantLine;
  const latestMilestone = getSegmentFirstLine(segment.latestMilestone);
  const readEditSummary = buildSegmentReadEditSummary(segment);
  const latestCommand = getLatestCodexCommand(segment);
  const scopedActivities = getActivitiesSinceCheckIn(segment);
  const scopedActivitySummary = summarizeSegmentActivitiesForSpeech([...scopedActivities].reverse().slice(0, 3));
  const unrelayedActivities = getUnrelayedActivities(segment);

  if (asksLastMessage) {
    if (blockingQuestion) return `Codex's last message was: ${blockingQuestion}`;
    if (finalOutcome) return `Codex's last message was: ${finalOutcome}`;
    if (latestMilestone) return `Codex's latest update was: ${latestMilestone}`;
    return "Codex has not produced a message for this segment yet.";
  }

  if (asksAboutQuestion) {
    if (blockingQuestion) return `Yes. Codex asked: ${blockingQuestion}`;
    return "No, Codex did not ask a question.";
  }

  if (asksWhatHappened) {
    const lead =
      segment.mode === "interrupt"
        ? "Codex interrupted the previous task."
        : segment.mode === "steer"
          ? "Codex adjusted the current task."
          : "Codex started a new task.";

    if (blockingQuestion) {
      return [lead, "It is waiting for input.", `It asked: ${blockingQuestion}`].join(" ").slice(0, 320);
    }

    if (scopedActivities.length === 0) {
      const currentState =
        segment.codexState === "running"
          ? summarizeRunningSegmentForSpeech(segment, segmentMessages)
          : summarizeSegmentStatus(segment, agentEvents);
      return `Nothing new since you last asked. ${currentState}`.slice(0, 320);
    }

    if (finalOutcome) {
      return [lead, `Latest result: ${finalOutcome}`, readEditSummary].filter(Boolean).join(" ").slice(0, 320);
    }

    if (scopedActivitySummary) {
      return [lead, scopedActivitySummary, readEditSummary].filter(Boolean).join(" ").slice(0, 320);
    }

    if (latestMilestone) {
      return [lead, `Latest step: ${latestMilestone}`, readEditSummary].filter(Boolean).join(" ").slice(0, 320);
    }
  }

  if (segment.codexState === "running") {
    if (asksAboutTiming) {
      if (latestCommandLooksLikeBuild(latestCommand)) {
        return "Hard to tell exactly. Codex is running a build right now.";
      }
      if (latestCommandLooksLikeChecks(latestCommand)) {
        return "Hard to tell exactly. Codex is still running checks.";
      }
      return "Hard to tell exactly. Codex is still working.";
    }
    if (segment.lastUserCheckInAt && unrelayedActivities.length === 0) {
      const shortStatus = summarizeRunningSegmentForSpeech(segment, segmentMessages).replace(/\.$/, "");
      return `Still ${shortStatus.charAt(0).toLowerCase()}${shortStatus.slice(1)}, nothing new since you last asked.`.slice(0, 120);
    }
    return summarizeRunningSegmentForSpeech(segment, segmentMessages);
  }

  return summarizeSegmentStatus(segment, agentEvents);
}

function getSegmentWorkingLabel(segment: CodexSegment | null) {
  if (!segment) return "idle";
  if (segment.codexState === "waiting_for_user") return "waiting for input...";
  if (segment.codexState !== "running") return "idle";

  const latestCommand = segment.commandsRun.at(-1);
  if (latestCommand) {
    if (latestCommand.includes("sed -n") || latestCommand.includes("cat ") || latestCommand.includes("rg ")) {
      return "reading files...";
    }
    if (latestCommand.includes("npm ") || latestCommand.includes("pnpm ") || latestCommand.includes("yarn ")) {
      return "running checks...";
    }
    return "running command...";
  }

  if (segment.filesEdited.length > 0) {
    return `editing ${segment.filesEdited.at(-1)}...`;
  }

  if (segment.latestMilestone) {
    return `${segment.latestMilestone.replace(/\.$/, "")}...`.slice(0, 120);
  }

  return "working...";
}

function getSegmentStatusLabel(segment: CodexSegment | null) {
  if (!segment) return "idle";
  if (segment.codexState === "waiting_for_user") return "needs input";
  if (segment.codexState === "running") {
    if (segment.mode === "interrupt") return "switching";
    if (segment.mode === "steer") return "adjusting";
    return "working";
  }
  return "idle";
}

function buildSegmentSnapshot(segment: CodexSegment | null) {
  if (!segment) return null;
  return {
    segmentId: segment.id,
    mode: segment.mode,
    codexState: segment.codexState,
    relayState: segment.relayState,
    sourceUtterance: segment.sourceUtterance,
    latestMilestone: segment.latestMilestone,
    blockingQuestion: segment.blockingQuestion,
    finalOutcome: segment.finalOutcome,
    filesRead: segment.filesRead,
    filesEdited: segment.filesEdited,
    commandsRun: segment.commandsRun.slice(-5),
    activities: segment.activities.slice(-8),
  };
}

function formatDuration(totalSeconds: number) {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return [hours, minutes, seconds].map((value) => String(value).padStart(2, "0")).join(":");
  }
  return [minutes, seconds].map((value) => String(value).padStart(2, "0")).join(":");
}

function formatLocalTime(timestamp: string) {
  const timeOnlyMatch = timestamp.match(/^(\d{2}:\d{2}:\d{2})(?:\.(\d+))?$/);
  if (timeOnlyMatch) {
    const [, base, fraction] = timeOnlyMatch;
    return fraction ? `${base}.${fraction.padEnd(2, "0").slice(0, 2)}` : base;
  }

  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return timestamp;
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 2,
    hour12: false,
  }).format(date);
}

function formatStatusLabel(value: string) {
  return value
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("-");
}

function TimestampLabel({ timestamp, className = "" }: { timestamp: string; className?: string }) {
  return (
    <span
      className={`font-mono tracking-[0.04em] text-zinc-500 ${className}`.trim()}
      style={{ fontSize: "10.5px", lineHeight: 1 }}
    >
      {formatLocalTime(timestamp)}
    </span>
  );
}

function messagePhaseLabel(message: RealtimeMessage) {
  if (message.role === "system") return "event";
  if (message.role === "assistant") {
    return message.status === "streaming" ? "streaming" : "";
  }
  if (message.status === "capturing") return "capturing";
  if (message.status === "partial") return "partial";
  return "";
}

function codexMessagePhaseLabel(message: CodexMessage) {
  if (message.role === "system") return "event";
  return message.status === "streaming" ? "streaming" : "";
}

function codexMessageKindLabel(message: CodexMessage) {
  if (message.role !== "assistant") return "";

  const labelByKind: Record<CodexMessageKind, string> = {
    reply: "reply",
    read: "read",
    edit: "edit",
    command: "command",
    plan: "plan",
    error: "error",
  };

  if (!message.kind) return "";
  return labelByKind[message.kind] ?? "";
}

function codexMessageKindClass(kind?: CodexMessageKind) {
  if (kind === "edit") return "border-[#b9f075]/20 bg-[#b9f075]/10 text-[#d8f5ab]";
  if (kind === "read") return "border-sky-300/20 bg-sky-300/10 text-sky-100";
  if (kind === "command") return "border-zinc-400/20 bg-zinc-400/10 text-zinc-200";
  if (kind === "plan") return "border-fuchsia-300/20 bg-fuchsia-300/10 text-fuchsia-100";
  if (kind === "error") return "border-red-300/20 bg-red-300/10 text-red-100";
  return "border-zinc-400/20 bg-zinc-400/10 text-zinc-200";
}

function statusDotClass(status: string) {
  if (status === "connected" || status === "active" || status === "apiKey") return "bg-[#b9f075]";
  if (status === "connecting" || status === "requesting-mic") return "bg-[#d0ef9e]";
  if (status === "error") return "bg-red-300";
  return "bg-zinc-400";
}

function panelBadgeClass() {
  return "h-8 rounded-full border-[#b9f075]/20 bg-[#b9f075]/10 px-3 text-[13px] font-medium text-[#d8f5ab]";
}

function eventToneClass(method?: string) {
  if (!method) return "text-zinc-400";
  if (method.startsWith("turn/")) return "text-white";
  if (method.startsWith("item/fileChange")) return "text-zinc-200";
  if (method.startsWith("item/commandExecution")) return "text-zinc-300";
  if (method.startsWith("item/agentMessage")) return "text-zinc-100";
  if (method === "thread/realtime/sdp") return "text-zinc-200";
  return "text-zinc-400";
}

function handoffEventClasses(kind?: "start" | "steer" | "interrupt" | "interrupted" | "refreshed") {
  if (kind === "interrupted" || kind === "refreshed") {
    return {
      badge: "",
      text: "text-zinc-500",
    };
  }
  if (kind === "steer") {
    return {
      badge: "border-[#7fe38b]/20 bg-[#7fe38b]/10 text-[#bff6b9]",
      text: "text-[#d8f7d0]",
    };
  }
  if (kind === "interrupt") {
    return {
      badge: "border-orange-400/20 bg-orange-400/10 text-orange-200",
      text: "text-orange-100",
    };
  }
  return {
    badge: "border-pink-400/20 bg-pink-400/10 text-pink-200",
    text: "text-pink-100",
  };
}

const REALTIME_WAVE_BARS = [0.22, 0.4, 0.62, 0.88, 0.68, 1, 0.74, 0.92, 0.56, 0.34, 0.18];

function RealtimeWaveBars({
  isMuted,
  isActive,
  compact = false,
}: {
  isMuted: boolean;
  isActive: boolean;
  compact?: boolean;
}) {
  const barWidth = compact ? 3 : 4;
  const baseHeight = compact ? 18 : 64;

  return (
    <div className={`flex items-center justify-center gap-[3px] ${compact ? "h-7" : "h-24"} w-full`}>
      {REALTIME_WAVE_BARS.map((height, index) => {
        const active = isActive && !isMuted;
        const renderedHeight = active ? Math.max(8, Math.round(baseHeight * height)) : compact ? 7 : 12;
        return (
          <span
            key={`${index}-${height}`}
            className={`rounded-full ${active ? "bg-[#b9f075]" : "bg-zinc-500/65"}`}
            style={{
              width: `${barWidth}px`,
              height: `${renderedHeight}px`,
              animation: active ? `realtime-wave 1.15s ease-in-out ${index * 0.08}s infinite` : "none",
              boxShadow: active ? "0 0 10px rgba(185,240,117,0.22)" : "none",
              transformOrigin: "center",
            }}
          />
        );
      })}
    </div>
  );
}

function RealtimeStatusBadge({
  isMuted,
  realtimeStatus,
}: {
  isMuted: boolean;
  realtimeStatus: OpenAIRealtimeStatus;
}) {
  const active = realtimeStatus === "active";

  return (
    <div className="flex w-[150px] items-center gap-3 rounded-full border border-white/10 bg-white/[0.04] px-3 py-2.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
      <div className="w-[52px]">
        <RealtimeWaveBars isMuted={isMuted} isActive={active} compact />
      </div>
      <div className="space-y-0.5">
        <div className="text-[10px] uppercase tracking-[0.18em] text-zinc-500">voice</div>
        <div className="text-[14px] font-semibold leading-none text-zinc-100">{isMuted ? "muted" : "live"}</div>
      </div>
    </div>
  );
}

function CodexStatusGlyph({ codexState }: { codexState: CodexSegmentState }) {
  const active = codexState === "running";
  const waiting = codexState === "waiting_for_user";
  const failed = codexState === "failed";
  const bars = [0.34, 0.7, 1, 0.76, 0.42];

  return (
    <div className="flex w-[52px] items-center justify-center gap-[3px]">
      {bars.map((height, index) => {
        const barClass = failed
          ? "bg-red-300/85"
          : waiting
            ? "bg-orange-300/85"
            : active
              ? "bg-[#b9f075]"
              : "bg-zinc-500/65";

        const renderedHeight = active ? Math.max(8, Math.round(18 * height)) : waiting ? Math.max(8, Math.round(14 * height)) : 8;
        return (
          <span
            key={`${index}-${height}`}
            className={`rounded-full ${barClass}`}
            style={{
              width: "3px",
              height: `${renderedHeight}px`,
              animation:
                active
                  ? `codex-status-wave 0.95s ease-in-out ${index * 0.07}s infinite`
                  : waiting
                    ? `codex-status-breathe 1.6s ease-in-out ${index * 0.1}s infinite`
                    : "none",
              boxShadow: active ? "0 0 10px rgba(185,240,117,0.22)" : waiting ? "0 0 10px rgba(253,186,116,0.18)" : "none",
              transformOrigin: "center",
            }}
          />
        );
      })}
    </div>
  );
}

function CodexStatusBadge({ codexState }: { codexState: CodexSegmentState }) {
  const label =
    codexState === "waiting_for_user"
      ? "waiting"
      : codexState === "completed"
        ? "complete"
        : codexState === "failed"
          ? "failed"
          : codexState;

  return (
    <div className="flex w-[150px] items-center gap-3 rounded-full border border-white/10 bg-white/[0.04] px-3 py-2.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
      <CodexStatusGlyph codexState={codexState} />
      <div className="space-y-0.5">
        <div className="text-[10px] uppercase tracking-[0.18em] text-zinc-500">codex</div>
        <div className="text-[14px] font-semibold leading-none text-zinc-100">{label}</div>
      </div>
    </div>
  );
}

function OpenAIWordmarkIcon() {
  return (
    <svg fill="currentColor" fillRule="evenodd" viewBox="0 0 24 24" aria-hidden="true" className="size-4">
      <path d="M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z" />
    </svg>
  );
}

function CodexWordmarkIcon() {
  return (
    <svg fill="currentColor" fillRule="evenodd" viewBox="0 0 24 24" aria-hidden="true" className="size-4">
      <path clipRule="evenodd" d="M8.086.457a6.105 6.105 0 013.046-.415c1.333.153 2.521.72 3.564 1.7a.117.117 0 00.107.029c1.408-.346 2.762-.224 4.061.366l.063.03.154.076c1.357.703 2.33 1.77 2.918 3.198.278.679.418 1.388.421 2.126a5.655 5.655 0 01-.18 1.631.167.167 0 00.04.155 5.982 5.982 0 011.578 2.891c.385 1.901-.01 3.615-1.183 5.14l-.182.22a6.063 6.063 0 01-2.934 1.851.162.162 0 00-.108.102c-.255.736-.511 1.364-.987 1.992-1.199 1.582-2.962 2.462-4.948 2.451-1.583-.008-2.986-.587-4.21-1.736a.145.145 0 00-.14-.032c-.518.167-1.04.191-1.604.185a5.924 5.924 0 01-2.595-.622 6.058 6.058 0 01-2.146-1.781c-.203-.269-.404-.522-.551-.821a7.74 7.74 0 01-.495-1.283 6.11 6.11 0 01-.017-3.064.166.166 0 00.008-.074.115.115 0 00-.037-.064 5.958 5.958 0 01-1.38-2.202 5.196 5.196 0 01-.333-1.589 6.915 6.915 0 01.188-2.132c.45-1.484 1.309-2.648 2.577-3.493.282-.188.55-.334.802-.438.286-.12.573-.22.861-.304a.129.129 0 00.087-.087A6.016 6.016 0 015.635 2.31C6.315 1.464 7.132.846 8.086.457zm-.804 7.85a.848.848 0 00-1.473.842l1.694 2.965-1.688 2.848a.849.849 0 001.46.864l1.94-3.272a.849.849 0 00.007-.854l-1.94-3.393zm5.446 6.24a.849.849 0 000 1.695h4.848a.849.849 0 000-1.696h-4.848z" />
    </svg>
  );
}

function PanelShell({
  title,
  description,
  icon,
  headerRight,
  children,
  contentClassName,
}: {
  title: string;
  description?: string;
  icon?: React.ReactNode;
  headerRight?: React.ReactNode;
  children: React.ReactNode;
  contentClassName?: string;
}) {
  return (
    <Card className="h-full border-white/8 bg-[#1d2421]/92 shadow-2xl shadow-black/20 backdrop-blur-sm">
      <CardHeader className="space-y-1 pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            {icon ? (
              <div className="flex size-7 items-center justify-center rounded-xl border border-white/8 bg-white/[0.03] text-zinc-100">
                {icon}
              </div>
            ) : null}
            <div>
              <CardTitle className="text-[1.05rem] font-semibold tracking-tight text-zinc-50">{title}</CardTitle>
              {description ? (
                <CardDescription className="text-sm leading-5 text-zinc-400/90">{description}</CardDescription>
              ) : null}
            </div>
          </div>
          {headerRight ? (
            <div className="shrink-0">
              {headerRight}
            </div>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className={contentClassName}>{children}</CardContent>
    </Card>
  );
}

function JsonRpcLogPanel({ entries }: { entries: LogEntry[] }) {
  return (
    <PanelShell
      title="JSON-RPC Log"
      description="Raw Codex app-server request and response traffic."
      icon={<TerminalSquare className="size-4" />}
      contentClassName="pt-0"
    >
      <ScrollArea className="h-[19rem] pr-3">
        <div className="space-y-1.5 rounded-xl border border-white/8 bg-[#171d1b] p-3 font-mono">
          {entries.length === 0 ? (
            <div className="rounded-lg border border-dashed border-white/10 bg-white/[0.02] px-3 py-5 text-sm text-zinc-500">
              No JSON-RPC traffic yet.
            </div>
          ) : (
            entries.map((entry) => (
              <div
                key={entry.id}
                className="rounded-md px-2 py-2 text-xs text-zinc-300 odd:bg-white/[0.015]"
              >
                <div className="mb-1.5 flex items-center gap-2 text-[10px] uppercase tracking-[0.22em] text-zinc-500">
                  <span>{entry.timestamp}</span>
                  <span className={entry.direction === "sent" ? "text-white" : "text-zinc-300"}>
                    {entry.direction === "sent" ? "sent" : "received"}
                  </span>
                </div>
                <pre className="overflow-x-auto whitespace-pre-wrap break-all text-[10.5px] leading-4.5">
                  {JSON.stringify(entry.message, null, 2)}
                </pre>
              </div>
            ))
          )}
        </div>
      </ScrollArea>
    </PanelShell>
  );
}

function RealtimeLogPanel({ entries }: { entries: RealtimeLog[] }) {
  return (
    <PanelShell
      title="OpenAI Realtime Log"
      description="Realtime events from the direct voice session."
      icon={<Radio className="size-4" />}
      contentClassName="pt-0"
    >
      <ScrollArea className="h-[19rem] pr-3">
        <div className="space-y-1.5 rounded-xl border border-white/8 bg-[#171d1b] p-3 font-mono">
          {entries.length === 0 ? (
            <div className="rounded-lg border border-dashed border-white/10 bg-white/[0.02] px-3 py-5 text-sm text-zinc-500">
              No OpenAI Realtime events yet.
            </div>
          ) : (
            entries.map((entry) => (
              <div
                key={entry.id}
                className="rounded-md px-2 py-2 text-xs text-zinc-300 odd:bg-white/[0.015]"
              >
                <div className="mb-1.5 flex items-center gap-2 text-[10px] uppercase tracking-[0.22em] text-zinc-500">
                  <span>{entry.timestamp}</span>
                  <span
                    className={
                      entry.direction === "client"
                        ? "text-white"
                        : entry.direction === "server"
                          ? "text-zinc-300"
                          : "text-zinc-500"
                    }
                  >
                    {entry.label}
                  </span>
                </div>
                <pre className="overflow-x-auto whitespace-pre-wrap break-all text-[10.5px] leading-4.5">
                  {entry.body}
                </pre>
              </div>
            ))
          )}
        </div>
      </ScrollArea>
    </PanelShell>
  );
}

function EventPanel({ events }: { events: AgentEvent[] }) {
  const filtered = events.filter((event) => event.method && AGENT_METHODS_OF_INTEREST.has(event.method));

  return (
    <PanelShell
      title="Agent Activity"
      description="High-signal Codex thread and item notifications."
      icon={<Activity className="size-4" />}
      contentClassName="pt-0"
    >
      <ScrollArea className="h-[19rem] pr-3">
        <div className="space-y-1.5 rounded-xl border border-white/8 bg-[#171d1b] p-3 font-mono">
          {filtered.length === 0 ? (
            <div className="rounded-lg border border-dashed border-white/10 bg-white/[0.02] px-3 py-5 text-sm text-zinc-500">
              No agent events yet.
            </div>
          ) : (
            filtered.map((event) => (
              <div key={event.id} className="rounded-md px-2 py-2 odd:bg-white/[0.015]">
                <div className="mb-1.5 flex items-center gap-2 text-[10px] uppercase tracking-[0.22em] text-zinc-500">
                  <span>{event.timestamp}</span>
                  <span className={eventToneClass(event.method)}>{event.method}</span>
                </div>
                <p className="text-[12px] leading-4.5 text-zinc-300">{event.summary}</p>
              </div>
            ))
          )}
        </div>
      </ScrollArea>
    </PanelShell>
  );
}

function CodexConversationPanel({
  messages,
  activeSegment,
}: {
  messages: CodexMessage[];
  activeSegment: CodexSegment | null;
}) {
  const workingLabel = getSegmentWorkingLabel(activeSegment);
  const statusLabel = getSegmentStatusLabel(activeSegment);
  const animateWorkingRow = activeSegment?.codexState === "running";
  const workingIndicatorClass = animateWorkingRow
    ? "bg-[#b9f075] shadow-[0_0_8px_rgba(185,240,117,0.4)]"
    : "bg-zinc-600/80 shadow-none";
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTop = 0;
  }, [messages, activeSegment?.id, activeSegment?.updatedAt]);

  return (
    <div className="flex h-full min-h-0 flex-col rounded-[1.55rem] border border-white/8 bg-[#171d1b] px-4 py-4">
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto pr-2 [scrollbar-gutter:stable]">
        <div className={messages.length === 0 ? "flex min-h-full items-center justify-center" : "flex flex-col-reverse gap-4"}>
          {messages.length === 0 ? (
            <div className="flex min-h-full items-center justify-center text-center">
              <div className="max-w-md space-y-2 px-6">
                <div className="text-[11px] uppercase tracking-[0.2em] text-zinc-600">conversation</div>
                <div className="text-[15px] text-zinc-500">No Codex messages yet.</div>
              </div>
            </div>
          ) : (
            messages.map((message) => (
              <div
                key={message.id}
                className={`space-y-1.5 py-0.5 ${message.role === "user" ? "text-right" : "text-left"}`}
              >
                {message.role === "system" ? (
                  <div className="relative flex min-h-6 items-center justify-center">
                    <span
                      className={`rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.16em] ${
                        handoffEventClasses(message.eventKind).badge
                      }`}
                    >
                      {message.text}
                    </span>
                    <TimestampLabel timestamp={message.timestamp} className="absolute right-0" />
                  </div>
                ) : (
                  <>
                    <div
                      className={`flex items-baseline gap-2 text-[11px] leading-none text-zinc-500 ${
                        message.role === "assistant" ? "justify-start" : "justify-end"
                      }`}
                    >
                      <TimestampLabel timestamp={message.timestamp} />
                      {codexMessageKindLabel(message) ? (
                        <span
                          className={`rounded-full border px-1.5 py-[2px] text-[9px] font-medium uppercase tracking-[0.14em] leading-none ${codexMessageKindClass(message.kind)}`}
                        >
                          {codexMessageKindLabel(message)}
                        </span>
                      ) : null}
                      {codexMessagePhaseLabel(message) ? (
                        message.status === "streaming" ? (
                          <StreamingPhaseLabel label={codexMessagePhaseLabel(message) ?? "streaming"} />
                        ) : (
                          <span className="text-zinc-500">{codexMessagePhaseLabel(message)}</span>
                        )
                      ) : null}
                    </div>
                    <div
                      className={`whitespace-pre-wrap text-[15px] leading-[1.65] ${
                        message.role === "assistant" ? "text-zinc-100" : "text-zinc-300"
                      }`}
                    >
                      {message.text || "..."}
                      {message.role === "assistant" && message.status === "streaming" ? (
                        <span className="ml-1 inline-block h-[14px] w-[6px] animate-pulse align-[-2px] rounded-sm bg-[#b9f075]" />
                      ) : null}
                    </div>
                  </>
                )}
              </div>
            ))
          )}
          {messages.length > 0 ? (
            <div className="py-1.5">
              <div
                className={`relative flex min-h-6 w-full items-center gap-3 overflow-hidden rounded-full border border-[#b9f075]/10 bg-[#b9f075]/[0.04] px-3 py-1.5 text-[10px] uppercase tracking-[0.18em] text-zinc-500 ${
                  animateWorkingRow ? "codex-working-row" : ""
                }`}
              >
                {animateWorkingRow ? (
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-y-0 left-[-24%] w-[24%] bg-[linear-gradient(90deg,transparent,rgba(185,240,117,0.14),transparent)] codex-working-sheen"
                  />
                ) : null}
                <span className="relative shrink-0 font-medium text-[#d8f5ab]">{statusLabel}</span>
                <span
                  className={`relative size-1.5 shrink-0 rounded-full ${workingIndicatorClass} ${animateWorkingRow ? "codex-working-dot" : ""}`}
                />
                <span className="min-w-0 flex-1 truncate text-zinc-300">{workingLabel}</span>
                {activeSegment ? <TimestampLabel timestamp={activeSegment.updatedAt} className="shrink-0" /> : null}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function RealtimeConversationPanel({ messages }: { messages: RealtimeMessage[] }) {
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTop = 0;
  }, [messages]);

  return (
    <div className="flex h-full min-h-0 flex-col rounded-[1.55rem] border border-white/8 bg-[#171d1b] px-4 py-4">
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto pr-2 [scrollbar-gutter:stable]">
        <div className={messages.length === 0 ? "flex min-h-full items-center justify-center" : "flex flex-col-reverse gap-4"}>
          {messages.length === 0 ? (
            <div className="flex min-h-full items-center justify-center text-center">
              <div className="max-w-md space-y-2 px-6">
                <div className="text-[11px] uppercase tracking-[0.2em] text-zinc-600">conversation</div>
                <div className="text-[15px] text-zinc-500">No conversation messages yet.</div>
              </div>
            </div>
          ) : (
            messages.map((message) => (
              <div
                key={message.id}
                className={`space-y-1.5 py-0.5 ${message.role === "user" ? "text-right" : "text-left"}`}
              >
                {message.role === "system" ? (
                  <div className="relative flex min-h-6 items-center justify-center">
                    <span
                      className={`rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.16em] ${
                        handoffEventClasses(message.eventKind).badge
                      }`}
                    >
                      {message.text}
                    </span>
                    <TimestampLabel timestamp={message.timestamp} className="absolute right-0" />
                  </div>
                ) : (
                  <>
                    <div
                      className={`flex items-baseline gap-2 text-[11px] leading-none text-zinc-500 ${
                        message.role === "user" ? "justify-end" : "justify-start"
                      }`}
                    >
                      {message.role === "user" ? (
                        <span className="rounded-full border border-white/8 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.14em] text-zinc-400">
                          {message.source}
                        </span>
                      ) : null}
                      <TimestampLabel timestamp={message.timestamp} />
                      {messagePhaseLabel(message) ? (
                        message.status === "streaming" ? (
                          <StreamingPhaseLabel label={messagePhaseLabel(message) ?? "streaming"} />
                        ) : (
                          <span className="text-zinc-500">{messagePhaseLabel(message)}</span>
                        )
                      ) : null}
                    </div>
                    <div
                      className={`whitespace-pre-wrap text-[15px] leading-[1.65] ${
                        message.role === "assistant" ? "text-zinc-100" : "text-zinc-300"
                      }`}
                    >
                      {message.text || "..."}
                      {message.role === "assistant" && message.status === "streaming" ? (
                        <span className="ml-1 inline-block h-[14px] w-[6px] animate-pulse align-[-2px] rounded-sm bg-[#b9f075]" />
                      ) : null}
                    </div>
                  </>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function StreamingPhaseLabel({ label }: { label: string }) {
  return (
    <span className="inline-flex items-baseline gap-1 text-[#b9f075]">
      <span className="streaming-label-glow">{label}</span>
      <span className="inline-flex w-[1.2em] justify-start tabular-nums">
        <span className="streaming-dot-1">.</span>
        <span className="streaming-dot-2">.</span>
        <span className="streaming-dot-3">.</span>
      </span>
    </span>
  );
}

function pickDefaultModel(models: ModelInfo[]) {
  const realtimeCandidate = models.find((model) => model.id.toLowerCase().includes("realtime"));
  return realtimeCandidate?.id ?? models[0]?.id ?? "";
}

function formatTranscriptExportSection<
  TMessage extends { role: string; text: string; timestamp: string; status: string }
>(title: string, messages: TMessage[]) {
  const body = messages.length === 0
    ? "No messages."
    : messages
        .map((message) => {
          const cleanedText = message.text.trim() || "(empty)";
          return `[${formatLocalTime(message.timestamp)}] ${message.role} (${message.status})\n${cleanedText}`;
        })
        .join("\n\n");

  return `${title}\n${"=".repeat(title.length)}\n${body}`;
}

export default function App() {
  const persistedRealtimeMessagesRef = useRef<RealtimeMessage[]>(
    normalizePersistedRealtimeMessages(
      readStoredJson<RealtimeMessage[]>(STORAGE_KEYS.realtimeMessages, []),
    ),
  );
  const persistedRealtimeLogsRef = useRef<RealtimeLog[]>(
    readStoredJson<RealtimeLog[]>(STORAGE_KEYS.realtimeLogs, []),
  );
  const persistedCodexMessagesRef = useRef<CodexMessage[]>([]);
  const persistedCodexLogRef = useRef<LogEntry[]>([]);
  const persistedCodexEventsRef = useRef<AgentEvent[]>([]);
  const persistedCodexSegmentsRef = useRef<CodexSegment[]>([]);
  const persistedReconnectIntentRef = useRef<PersistedReconnectIntent>(
    readStoredJson<PersistedReconnectIntent>(STORAGE_KEYS.reconnectIntent, {
      shouldReconnectRealtime: false,
    }),
  );
  const [wsUrl] = useState("ws://localhost:3001?target=ws://127.0.0.1:3000");
  const [selectedModel, setSelectedModel] = useState("");
  const [realtimeText, setRealtimeText] = useState("");
  const [authError, setAuthError] = useState<string | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [codexTaskText, setCodexTaskText] = useState("");
  const [showExtraOverlay, setShowExtraOverlay] = useState(false);
  const [copyLogsState, setCopyLogsState] = useState<"idle" | "copied" | "error">("idle");

  const {
    status,
    log,
    agentEvents,
    thread,
    models,
    account,
    connect,
    startThread,
    readAccount,
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
  } = useCodexWebSocket({
    initialLog: persistedCodexLogRef.current,
    initialAgentEvents: persistedCodexEventsRef.current,
    initialCodexMessages: persistedCodexMessagesRef.current,
    initialSegments: persistedCodexSegmentsRef.current,
  });

  const {
    status: realtimeStatus,
    error: realtimeError,
    lastError: realtimeLastError,
    logs: realtimeLogs,
    messages: realtimeMessages,
    isMicMuted,
    connectedAt: realtimeConnectedAt,
    elapsedSeconds: realtimeElapsedSeconds,
    connect: connectRealtime,
    disconnect: disconnectRealtime,
    requestResponse: requestRealtimeResponse,
    sendText: sendRealtimeText,
    toggleMicMuted,
    isAssistantSpeaking,
    skipAssistant,
    addSystemMessage: addRealtimeSystemMessage,
  } = useOpenAIRealtime({
    initialMessages: persistedRealtimeMessagesRef.current,
    initialLogs: persistedRealtimeLogsRef.current,
  });

  const sdpHandlerRef = useRef<((sdp: string) => void) | null>(null);
  const realtimeInputRef = useRef<HTMLInputElement | null>(null);
  const prevEventCount = useRef(0);
  const lastHandledRealtimeMessageIdRef = useRef<string | null>(
    [...persistedRealtimeMessagesRef.current]
      .reverse()
      .find((message) => message.role === "user" && message.status === "final")
      ?.id ?? null,
  );
  const routeCacheRef = useRef(new Map<string, RoutedIntent>());
  const queuedInterruptReplacementRef = useRef<{ request: string; segmentId: string } | null>(null);
  const pendingCodexNarrationRef = useRef<{ request: string; segmentId: string } | null>(null);
  const lastRelayedQuestionRef = useRef<string | null>(null);
  const debugNotesRef = useRef<DebugNote[]>([]);
  const realtimeReconnectAttemptAtRef = useRef(0);
  const codexReconnectAttemptAtRef = useRef(0);
  const latestRealtimeUserMessageIdRef = useRef<string | null>(null);
  const [threadError, setThreadError] = useState<string | null>(null);
  const latestSegment = getCurrentSegment(segments);
  const currentSegment = findPreferredSegment(segments, activeTurnStatus);
  const currentCodexState: CodexSegmentState = currentSegment?.codexState ?? "idle";
  const currentCodexStatus = summarizeSegmentStatus(currentSegment, agentEvents);
  const paneOnlyMode = true;

  const addDebugNote = useCallback((label: string, detail?: string) => {
    const nextNote: DebugNote = {
      timestamp: formatNowLocal(2),
      label,
      detail: detail?.slice(0, 240),
    };
    debugNotesRef.current = [...debugNotesRef.current, nextNote].slice(-80);
    console.debug(`[voice-codex] ${label}`, detail ?? "");
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    setShowExtraOverlay(params.has("debug"));
  }, []);

  useEffect(() => {
    const restoredMessages = persistedRealtimeMessagesRef.current;
    if (restoredMessages.length === 0) return;
    const lastRestoredMessage = restoredMessages.at(-1);
    if (
      lastRestoredMessage?.role === "system" &&
      lastRestoredMessage.eventKind === "refreshed"
    ) {
      return;
    }
    const hasRealHistory = restoredMessages.some(
      (message) => (message.role === "user" || message.role === "assistant") && message.text.trim(),
    );
    if (!hasRealHistory) return;
    if (typeof window !== "undefined") {
      const latestRealMessageId =
        [...restoredMessages]
          .reverse()
          .find((message) => (message.role === "user" || message.role === "assistant") && message.text.trim())
          ?.id ?? null;
      const previousMarkedRealMessageId = window.sessionStorage.getItem(PAGE_REFRESH_MARKER_REAL_MESSAGE_KEY);
      if (latestRealMessageId && previousMarkedRealMessageId === latestRealMessageId) return;
      const loadId = String(Math.floor(window.performance.timeOrigin));
      const previousLoadId = window.sessionStorage.getItem(PAGE_REFRESH_MARKER_LOAD_KEY);
      if (previousLoadId === loadId) return;
      window.sessionStorage.setItem(PAGE_REFRESH_MARKER_LOAD_KEY, loadId);
      if (latestRealMessageId) {
        window.sessionStorage.setItem(PAGE_REFRESH_MARKER_REAL_MESSAGE_KEY, latestRealMessageId);
      }
    }
    addRealtimeSystemMessage("page refreshed", "refreshed");
  }, [addRealtimeSystemMessage]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.removeItem(STORAGE_KEYS.codexMessages);
    window.localStorage.removeItem(STORAGE_KEYS.codexLog);
    window.localStorage.removeItem(STORAGE_KEYS.codexEvents);
    window.localStorage.removeItem(STORAGE_KEYS.codexSegments);
  }, []);

  useEffect(() => {
    writeStoredJson(STORAGE_KEYS.realtimeMessages, realtimeMessages.slice(-PERSIST_LIMITS.realtimeMessages));
  }, [realtimeMessages]);

  useEffect(() => {
    writeStoredJson(STORAGE_KEYS.realtimeLogs, realtimeLogs.slice(-PERSIST_LIMITS.realtimeLogs));
  }, [realtimeLogs]);

  useEffect(() => {
    const staleTimer = window.setInterval(() => {
      segments.forEach((segment) => {
        if (segment.codexState !== "running") return;
        const supersedingSegment = findSupersedingSegment(segments, segment);
        if (supersedingSegment) {
          updateSegment(segment.id, (seg) => ({
            ...seg,
            codexState: "failed",
            latestMilestone: "Superseded by a newer task.",
            finalOutcome: seg.finalOutcome ?? "Superseded by a newer task.",
            activities: [
              ...seg.activities,
              {
                id: `cleanup-${seg.id}-superseded`,
                kind: "error" as const,
                summary: "Superseded by a newer task.",
                timestamp: formatNowLocal(2),
              },
            ].slice(-12),
          }));
          addDebugNote("stale_segment_cleanup", `segment=${segment.id}; reason=superseded; by=${supersedingSegment.id}`);
          return;
        }

        if (!segmentLooksStale(segment, activeTurnStatus)) return;
        updateSegment(segment.id, (seg) => ({
          ...seg,
          codexState: "failed",
          latestMilestone: "Interrupted before completion.",
          finalOutcome: seg.finalOutcome ?? "Interrupted before completion.",
          activities: [
            ...seg.activities,
            {
              id: `cleanup-${seg.id}-interrupted`,
              kind: "error" as const,
              summary: "Interrupted before completion.",
              timestamp: formatNowLocal(2),
            },
          ].slice(-12),
        }));
        addDebugNote("stale_segment_cleanup", `segment=${segment.id}; reason=timeout`);
      });
    }, 5000);
    return () => window.clearInterval(staleTimer);
  }, [activeTurnStatus, addDebugNote, segments, updateSegment]);

  useEffect(() => {
    const nextIntent = { ...persistedReconnectIntentRef.current };
    if (realtimeStatus === "active" || realtimeStatus === "connecting" || realtimeStatus === "requesting-mic") {
      nextIntent.shouldReconnectRealtime = true;
    }
    persistedReconnectIntentRef.current = nextIntent;
    writeStoredJson(STORAGE_KEYS.reconnectIntent, nextIntent);
  }, [realtimeStatus, status]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const exportLogs = () => {
      const projectPath = window.IDEBridge?.projectPath?.trim() || getCodexProjectCwd();
      return [
        `Voice Codex Export`,
        `Project: ${projectPath}`,
        ``,
        formatTranscriptExportSection("Realtime Voice Agent", realtimeMessages),
        ``,
        formatTranscriptExportSection("Codex", codexMessages),
        ``,
        `Session State`,
        `=============`,
        `Realtime status: ${realtimeStatus}`,
        `Realtime reconnect intent: ${persistedReconnectIntentRef.current.shouldReconnectRealtime ? "on" : "off"}`,
        `Codex socket status: ${status}`,
        `Codex state: ${currentCodexState}`,
        `Active turn status: ${activeTurnStatus}`,
        `Active turn id: ${activeTurnId ?? "(none)"}`,
        `Preferred segment: ${currentSegment?.id ?? "(none)"}`,
        `Latest segment: ${latestSegment?.id ?? "(none)"}`,
        ``,
        `Debug Notes`,
        `===========`,
        ...(debugNotesRef.current.length === 0
          ? ["(none)"]
          : debugNotesRef.current.map((note) => `[${note.timestamp}] ${note.label}${note.detail ? ` :: ${note.detail}` : ""}`)),
      ].join("\n");
    };
    window.__VOICE_CODEX_EXPORT_TEXT__ = exportLogs;
    window.__VOICE_CODEX_COPY_LOGS__ = exportLogs;

    return () => {
      delete window.__VOICE_CODEX_EXPORT_TEXT__;
      delete window.__VOICE_CODEX_COPY_LOGS__;
    };
  }, [activeTurnId, activeTurnStatus, codexMessages, currentCodexState, currentSegment?.id, latestSegment?.id, realtimeMessages, realtimeStatus, status]);

  const routeIntent = async (message: string, codexRunning: boolean): Promise<RoutedIntent> => {
    const latestCodexReply = [...codexMessages]
      .reverse()
      .find((entry) => entry.role === "assistant" && entry.status === "final");
    const latestSegmentMessages = getSegmentMessages(codexMessages, currentSegment?.id)
      .slice(-6)
      .map((entry) => ({
        role: entry.role,
        text: entry.text,
        status: entry.status,
        eventKind: entry.eventKind ?? null,
      }));
    const recentConversation = realtimeMessages
      .slice(-6)
      .map((entry) => ({ role: entry.role, text: entry.text }));
    const currentSegmentSnapshot = buildSegmentSnapshot(currentSegment);
    const latestCompletedSegmentSnapshot = buildSegmentSnapshot(
      [...segments].reverse().find((segment) => segment.codexState === "completed" || segment.codexState === "failed") ?? null,
    );

    const response = await fetch("/__intent/route", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message,
        codexRunning,
        latestCodexReply: latestCodexReply?.text ?? null,
        currentCodexStatus,
        latestSegmentMessages,
        currentSegment: currentSegmentSnapshot,
        latestCompletedSegment: latestCompletedSegmentSnapshot,
        recentConversation,
      }),
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(text || `Intent routing failed (${response.status})`);
    }

    return JSON.parse(text) as RoutedIntent;
  };

  if (agentEvents.length !== prevEventCount.current) {
    prevEventCount.current = agentEvents.length;
    const last = agentEvents[agentEvents.length - 1];
    if (last?.method === "thread/realtime/sdp" && sdpHandlerRef.current) {
      const sdp = (last.raw as Record<string, unknown>)?.sdp as string;
      if (sdp) sdpHandlerRef.current(sdp);
    }
  }

  useEffect(() => {
    if (models.length === 0) return;
    if (!models.some((model) => model.id === selectedModel)) {
      setSelectedModel(pickDefaultModel(models));
    }
  }, [models, selectedModel]);

  const handleApiKeyLogin = async () => {
    setAuthBusy(true);
    setAuthError(null);
    try {
      const response = await fetch("/__codex_app_server/account/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ wsUrl }),
      });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(text || `Failed to log into Codex app-server (${response.status})`);
      }
      await readAccount();
    } catch (error) {
      setAuthError((error as Error).message);
    } finally {
      setAuthBusy(false);
    }
  };

  const handleStartThread = async () => {
    setThreadError(null);
    if (!selectedModel) {
      throw new Error("No valid Codex model loaded yet.");
    }
    try {
      await startThread(getCodexProjectCwd(), selectedModel);
    } catch (error) {
      setThreadError((error as Error).message);
    }
  };

  const handleStartRealtime = async () => {
    const nextIntent = { ...persistedReconnectIntentRef.current, shouldReconnectRealtime: true };
    persistedReconnectIntentRef.current = nextIntent;
    writeStoredJson(STORAGE_KEYS.reconnectIntent, nextIntent);
    const reconnectHistory = realtimeMessages.length > 0
      ? realtimeMessages
      : persistedRealtimeMessagesRef.current;
    await connectRealtime({
      model: "gpt-realtime",
      voice: "marin",
      instructions: buildRealtimeConnectInstructions(reconnectHistory),
      preserveHistory: true,
    });
  };

  const handleClearChat = async () => {
    persistedRealtimeMessagesRef.current = [];
    persistedRealtimeLogsRef.current = [];
    lastHandledRealtimeMessageIdRef.current = null;
    routeCacheRef.current.clear();
    queuedInterruptReplacementRef.current = null;
    pendingCodexNarrationRef.current = null;
    lastRelayedQuestionRef.current = null;
    debugNotesRef.current = [];
    setRealtimeText("");
    setCodexTaskText("");
    setThreadError(null);

    if (typeof window !== "undefined") {
      window.localStorage.removeItem(STORAGE_KEYS.realtimeMessages);
      window.localStorage.removeItem(STORAGE_KEYS.realtimeLogs);
      window.localStorage.removeItem(STORAGE_KEYS.codexMessages);
      window.localStorage.removeItem(STORAGE_KEYS.codexLog);
      window.localStorage.removeItem(STORAGE_KEYS.codexEvents);
      window.localStorage.removeItem(STORAGE_KEYS.codexSegments);
    }

    const nextIntent = { ...persistedReconnectIntentRef.current, shouldReconnectRealtime: true };
    persistedReconnectIntentRef.current = nextIntent;
    writeStoredJson(STORAGE_KEYS.reconnectIntent, nextIntent);

    await connectRealtime({
      model: "gpt-realtime",
      voice: "marin",
      instructions: REALTIME_CONNECT_INSTRUCTIONS,
      preserveHistory: false,
    });
    connect(wsUrl, false);
  };

  const handleSendRealtimeText = () => {
    const text = realtimeText.trim();
    if (!text) return;
    try {
      sendRealtimeText(text, { requestResponse: false, visible: true });
      setRealtimeText("");
    } catch (error) {
      console.error(error);
    }
  };

  useEffect(() => {
    if (realtimeStatus !== "active") return;
    const timeout = window.setTimeout(() => {
      realtimeInputRef.current?.focus();
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [realtimeStatus]);

  useEffect(() => {
    if (!persistedReconnectIntentRef.current.shouldReconnectRealtime) return;
    if (realtimeStatus !== "idle" && realtimeStatus !== "error") return;
    const now = Date.now();
    if (now - realtimeReconnectAttemptAtRef.current < 2500) return;
    realtimeReconnectAttemptAtRef.current = now;
    void handleStartRealtime().catch((error) => {
      console.error(error);
    });
  }, [handleStartRealtime, realtimeStatus]);

  useEffect(() => {
    if (status !== "disconnected" && status !== "error") return;
    const now = Date.now();
    if (now - codexReconnectAttemptAtRef.current < 2500) return;
    codexReconnectAttemptAtRef.current = now;
    connect(wsUrl, false);
  }, [connect, status, wsUrl]);

  useEffect(() => {
    if (status !== "connected") return;
    if (account?.type === "apiKey") return;
    if (authBusy) return;
    void handleApiKeyLogin();
  }, [account?.type, authBusy, status]);

  useEffect(() => {
    if (status !== "connected") return;
    if (account?.type !== "apiKey") return;
    if (thread) return;
    if (threadError) return;
    if (models.length === 0) return;
    if (!selectedModel) return;
    void handleStartThread();
  }, [account?.type, models.length, selectedModel, status, thread, threadError]);

  useEffect(() => {
    const latestFinalUserMessage = [...realtimeMessages]
      .reverse()
      .find((message) => message.role === "user" && message.status === "final");

    if (!latestFinalUserMessage) return;
    latestRealtimeUserMessageIdRef.current = latestFinalUserMessage.id;
    if (lastHandledRealtimeMessageIdRef.current === latestFinalUserMessage.id) return;

    lastHandledRealtimeMessageIdRef.current = latestFinalUserMessage.id;

    const dispatch = async () => {
      const abortIfSuperseded = () => latestRealtimeUserMessageIdRef.current !== latestFinalUserMessage.id;
      const exactRealtimeMemoryReply = buildExactRealtimeMemoryReply(latestFinalUserMessage.text, realtimeMessages);
      if (exactRealtimeMemoryReply) {
        addDebugNote("relay_realtime_memory", `reply=${exactRealtimeMemoryReply}`);
        sendRealtimeText(
          `Say exactly this to the user and nothing else:\n${exactRealtimeMemoryReply}`,
          { requestResponse: true, visible: false },
        );
        return;
      }

      let routed = routeCacheRef.current.get(latestFinalUserMessage.id);
      if (!routed) {
        routed = await routeIntent(latestFinalUserMessage.text, currentCodexState === "running" || currentCodexState === "waiting_for_user");
        if (abortIfSuperseded()) return;
        routeCacheRef.current.set(latestFinalUserMessage.id, routed);
      }
      if (abortIfSuperseded()) return;

      if (routed.action === "chat_only") {
        if (routed.chat_mode === "relay_codex_status") {
          let exactReply = "Codex is idle right now.";
          let relayPriority = "idle_or_unknown";
          if (currentSegment?.blockingQuestion && currentSegment.relayState !== "clarification_spoken") {
            relayPriority = "blocking_question";
            exactReply = `Codex needs your input. It asked: ${getSegmentFirstLine(currentSegment.blockingQuestion)}`;
          } else if (currentSegment?.codexState === "running") {
            relayPriority = "running";
            exactReply = buildExactCodexRelayReply(
              latestFinalUserMessage.text,
              currentSegment,
              getSegmentMessages(codexMessages, currentSegment.id),
              agentEvents,
            );
          } else if (currentSegment?.codexState === "completed" || currentSegment?.codexState === "failed") {
            relayPriority = currentSegment.codexState;
            exactReply = buildExactCodexRelayReply(
              latestFinalUserMessage.text,
              currentSegment,
              getSegmentMessages(codexMessages, currentSegment.id),
              agentEvents,
            );
          } else {
            exactReply = buildExactCodexRelayReply(
              latestFinalUserMessage.text,
              currentSegment,
              getSegmentMessages(codexMessages, currentSegment?.id),
              agentEvents,
            );
          }
          addDebugNote(
            "relay_codex_status",
            `priority=${relayPriority}; segment=${currentSegment?.id ?? "none"}; state=${currentSegment?.codexState ?? "idle"}; reply=${exactReply}`,
          );
          if (currentSegment) {
            if (currentSegment.blockingQuestion) {
              setSegmentRelayState(currentSegment.id, "clarification_spoken");
            } else if (currentSegment.codexState === "running") {
              setSegmentRelayState(currentSegment.id, "progress_spoken");
            }
            updateSegment(currentSegment.id, (seg) => ({
              ...seg,
              lastUserCheckInAt: formatNowLocal(0),
              lastRelayedActivityIndex: seg.activities.length - 1,
            }));
          }
          sendRealtimeText(
            `Say exactly this to the user and nothing else:\n${exactReply}`,
            { requestResponse: true, visible: false },
          );
          return;
        }

        if (routed.chat_mode === "relay_latest_codex") {
          const relevantSegment =
            currentSegment ??
            [...segments].reverse().find((segment) => segment.finalOutcome || segment.blockingQuestion || segment.latestMilestone) ??
            null;
          if (relevantSegment) {
            const exactReply = buildExactCodexRelayReply(
              latestFinalUserMessage.text,
              relevantSegment,
              getSegmentMessages(codexMessages, relevantSegment.id),
              agentEvents,
            );
            addDebugNote(
              "relay_latest_codex",
              `segment=${relevantSegment.id}; state=${relevantSegment.codexState}; reply=${exactReply}`,
            );
            sendRealtimeText(
              `Say exactly this to the user and nothing else:\n${exactReply}`,
              { requestResponse: true, visible: false },
            );
            return;
          }
        }

        requestRealtimeResponse();
        return;
      }

      if (status !== "connected") return;
      setThreadError(null);

      const codexDispatchText = normalizeCodexDispatchText(latestFinalUserMessage.text);
      addDebugNote(
        "codex_dispatch_text",
        `original=${latestFinalUserMessage.text}; normalized=${codexDispatchText || latestFinalUserMessage.text}`,
      );

      let activeThread = thread;
      if (!activeThread) {
        if (!selectedModel) throw new Error("No valid Codex model loaded yet.");
        activeThread = await startThread(getCodexProjectCwd(), selectedModel);
        if (abortIfSuperseded()) return;
      }

      if (routed.action === "codex_interrupt" && activeTurnStatus === "running") {
        const segmentId = beginSegment("interrupt", latestFinalUserMessage.text);
        queuedInterruptReplacementRef.current = { request: codexDispatchText || latestFinalUserMessage.text, segmentId };
        pendingCodexNarrationRef.current = { request: codexDispatchText || latestFinalUserMessage.text, segmentId };
        await interruptTurn(activeThread.id);
        addRealtimeSystemMessage("interrupt", "interrupt");
        return;
      }

      if (routed.action === "codex_steer" && activeTurnStatus === "running" && activeTurnId) {
        const segmentId = beginSegment("steer", latestFinalUserMessage.text);
        pendingCodexNarrationRef.current = { request: codexDispatchText || latestFinalUserMessage.text, segmentId };
        await steerTurn(activeThread.id, codexDispatchText || latestFinalUserMessage.text, segmentId);
        addRealtimeSystemMessage("steer", "steer");
        return;
      }

      if (activeTurnStatus === "idle") {
        const segmentId = beginSegment("start", latestFinalUserMessage.text);
        pendingCodexNarrationRef.current = { request: codexDispatchText || latestFinalUserMessage.text, segmentId };
        await startTurn(activeThread.id, codexDispatchText || latestFinalUserMessage.text, segmentId);
        addRealtimeSystemMessage("new turn", "start");
      }
    };

    void dispatch().catch((error) => {
      setThreadError((error as Error).message);
    });
  }, [
    activeTurnId,
    activeTurnStatus,
    addDebugNote,
    addRealtimeSystemMessage,
    agentEvents,
    codexMessages,
    beginSegment,
    currentCodexState,
    currentCodexStatus,
    currentSegment,
    interruptTurn,
    realtimeMessages,
    requestRealtimeResponse,
    selectedModel,
    sendRealtimeText,
    segments,
    setSegmentRelayState,
    startThread,
    startTurn,
    status,
    steerTurn,
    thread,
    updateSegment,
  ]);

  useEffect(() => {
    if (!currentSegment) return;
    if (currentSegment.codexState !== "waiting_for_user") return;
    if (!currentSegment.blockingQuestion) return;
    if (currentSegment.relayState === "clarification_spoken" || currentSegment.relayState === "completion_spoken") return;
    if (lastRelayedQuestionRef.current === currentSegment.blockingQuestion) {
      addDebugNote("clarification_relay_skipped", `duplicate_question; segment=${currentSegment.id}`);
      return;
    }

    if (pendingCodexNarrationRef.current?.segmentId === currentSegment.id) {
      pendingCodexNarrationRef.current = null;
    }

    try {
      lastRelayedQuestionRef.current = currentSegment.blockingQuestion;
      addDebugNote(
        "clarification_relay_sent",
        `segment=${currentSegment.id}; question=${getSegmentFirstLine(currentSegment.blockingQuestion) ?? ""}`,
      );
      sendRealtimeText(
        `Codex needs your input. It asked: "${currentSegment.blockingQuestion}". Relay this question to the user briefly. Do not add anything else.`,
        { requestResponse: true, visible: false },
      );
      setSegmentRelayState(currentSegment.id, "clarification_spoken");
    } catch (error) {
      console.error(error);
    }
  }, [addDebugNote, currentSegment, sendRealtimeText, setSegmentRelayState]);

  useEffect(() => {
    if (activeTurnStatus !== "idle" || !thread || !queuedInterruptReplacementRef.current) return;

    const replacement = queuedInterruptReplacementRef.current;
    queuedInterruptReplacementRef.current = null;
    pendingCodexNarrationRef.current = replacement;

    void startTurn(thread.id, replacement.request, replacement.segmentId).catch((error) => {
      setThreadError((error as Error).message);
    });
  }, [activeTurnStatus, startTurn, thread]);

  useEffect(() => {
    if (!pendingCodexNarrationRef.current) return;
    if (queuedInterruptReplacementRef.current) return;
    if (activeTurnStatus !== "idle") return;

    const pending = pendingCodexNarrationRef.current;
    const targetSegment = segments.find((segment) => segment.id === pending.segmentId);
    if (!targetSegment) return;
    if (targetSegment.codexState !== "completed" && targetSegment.codexState !== "failed") return;
    if (targetSegment.relayState === "completion_spoken") return;

    const hasMeaningfulSummary = Boolean(
      getSegmentFirstLine(targetSegment.finalOutcome) ||
      getSegmentFirstLine(targetSegment.latestMilestone) ||
      targetSegment.filesEdited.length ||
      targetSegment.filesRead.length ||
      getUnrelayedActivities(targetSegment).length,
    );

    pendingCodexNarrationRef.current = null;
    if (!hasMeaningfulSummary) {
      addDebugNote("completion_relay_skipped", `empty_summary; segment=${targetSegment.id}; state=${targetSegment.codexState}`);
      return;
    }

    try {
      addDebugNote(
        "completion_relay_sent",
        `segment=${targetSegment.id}; state=${targetSegment.codexState}; summary=${getSegmentFirstLine(targetSegment.finalOutcome) ?? getSegmentFirstLine(targetSegment.latestMilestone) ?? "activity_only"}`,
      );
      sendRealtimeText(
        `Codex finished a segment. Give the user a very short spoken summary of what changed or what Codex accomplished. Use only the structured segment summary below. Do not read raw command output. Do not repeat the user's wording. Keep it to one or two short sentences. End with one very short follow-up question, for example "Want tweaks?" No invention.\n\nOriginal user request:\n${pending.request}\n\nCodex segment summary:\n${JSON.stringify(buildSegmentSnapshot(targetSegment), null, 2)}\n\nCondensed status:\n${summarizeSegmentStatus(targetSegment, agentEvents)}`,
        { requestResponse: true, visible: false },
      );
      updateSegment(targetSegment.id, (seg) => ({
        ...seg,
        relayState: "completion_spoken",
        lastRelayedActivityIndex: seg.activities.length - 1,
      }));
    } catch (error) {
      console.error(error);
    }
  }, [activeTurnStatus, addDebugNote, agentEvents, segments, sendRealtimeText, updateSegment]);

  const handleSendCodexTask = async () => {
    const task = codexTaskText.trim();
    if (!task) return;
    if (status !== "connected") {
      setThreadError("Connect Codex app-server first.");
      return;
    }

    setThreadError(null);

    try {
      let activeThread = thread;
      if (!activeThread) {
        if (!selectedModel) throw new Error("No valid Codex model loaded yet.");
        activeThread = await startThread(getCodexProjectCwd(), selectedModel);
      }
      await startTurn(activeThread.id, task);
      setCodexTaskText("");
    } catch (error) {
      setThreadError((error as Error).message);
    }
  };

  const handleCopyLogs = async () => {
    try {
      const exportText = window.__VOICE_CODEX_COPY_LOGS__?.() ?? window.__VOICE_CODEX_EXPORT_TEXT__?.();
      if (!exportText) throw new Error("Export text unavailable");

      let copied = false;

      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        try {
          await navigator.clipboard.writeText(exportText);
          copied = true;
        } catch {
          copied = false;
        }
      }

      {
        const textArea = document.createElement("textarea");
        textArea.value = exportText;
        textArea.setAttribute("readonly", "true");
        textArea.style.position = "fixed";
        textArea.style.opacity = "0";
        document.body.appendChild(textArea);
        textArea.select();
        copied = document.execCommand("copy") || copied;
        document.body.removeChild(textArea);
      }

      if (!copied) {
        throw new Error("Clipboard copy failed");
      }

      setCopyLogsState("copied");
      window.setTimeout(() => setCopyLogsState("idle"), 1800);
    } catch (error) {
      console.error(error);
      setCopyLogsState("error");
      window.setTimeout(() => setCopyLogsState("idle"), 2200);
    }
  };

  return (
    <div className={`dark bg-transparent text-zinc-50 ${paneOnlyMode ? "h-screen overflow-hidden" : "min-h-screen"}`}>
      <style>{`
        @keyframes streaming-label-pulse {
          0%, 100% { color: rgba(185, 240, 117, 0.78); text-shadow: 0 0 0 rgba(185, 240, 117, 0); }
          50% { color: rgba(216, 245, 171, 1); text-shadow: 0 0 10px rgba(185, 240, 117, 0.28); }
        }
        @keyframes streaming-dot-fade {
          0%, 20% { opacity: 0.18; }
          50% { opacity: 1; }
          100% { opacity: 0.18; }
        }
        @keyframes realtime-wave {
          0%, 100% { transform: scaleY(0.48); opacity: 0.86; }
          50% { transform: scaleY(1.02); opacity: 1; }
        }
        @keyframes codex-status-wave {
          0%, 100% { transform: scaleY(0.52); opacity: 0.82; }
          50% { transform: scaleY(1.08); opacity: 1; }
        }
        @keyframes codex-status-breathe {
          0%, 100% { transform: scaleY(0.82); opacity: 0.72; }
          50% { transform: scaleY(1); opacity: 1; }
        }
        @keyframes codex-working-dot {
          0%, 100% { transform: scale(0.92); opacity: 0.68; box-shadow: 0 0 0 rgba(185,240,117,0); }
          50% { transform: scale(1.18); opacity: 1; box-shadow: 0 0 14px rgba(185,240,117,0.45); }
        }
        @keyframes codex-working-sheen {
          0% { transform: translateX(0); opacity: 0; }
          15% { opacity: 1; }
          55% { opacity: 1; }
          100% { transform: translateX(520%); opacity: 0; }
        }
        @keyframes codex-working-border {
          0%, 100% { border-color: rgba(185,240,117,0.08); background-color: rgba(185,240,117,0.04); }
          50% { border-color: rgba(185,240,117,0.18); background-color: rgba(185,240,117,0.07); }
        }
        .codex-working-row {
          animation: codex-working-border 2.6s ease-in-out infinite;
        }
        .codex-working-dot {
          animation: codex-working-dot 1.35s ease-in-out infinite;
        }
        .codex-working-sheen {
          animation: codex-working-sheen 2.9s ease-in-out infinite;
        }
        .streaming-label-glow {
          animation: streaming-label-pulse 1.8s ease-in-out infinite;
        }
        .streaming-dot-1,
        .streaming-dot-2,
        .streaming-dot-3 {
          animation: streaming-dot-fade 1.2s ease-in-out infinite;
        }
        .streaming-dot-2 {
          animation-delay: 0.18s;
        }
        .streaming-dot-3 {
          animation-delay: 0.36s;
        }
      `}</style>
      <div className={`flex flex-col gap-4 ${paneOnlyMode ? "h-full w-full px-3 py-3 sm:px-4 lg:px-5" : "mx-auto max-w-[1180px] px-3 py-4 sm:px-5 lg:px-6"}`}>
        {!paneOnlyMode ? (
          <Card className="overflow-hidden border-white/8 bg-[#1b221f]/96 shadow-xl shadow-black/20">
            <CardContent className="flex flex-col gap-4 px-4 py-4 lg:flex-row lg:items-center lg:justify-between">
              <div className="max-w-3xl space-y-3">
                <Badge variant="outline" className="border-white/10 bg-white/[0.03] text-zinc-300">
                  Shack15 Hackathon Build
                </Badge>
                <div className="space-y-1.5">
                  <h1 className="text-2xl font-semibold tracking-tight text-zinc-50 sm:text-3xl lg:text-[2.1rem]">
                    Voice Codex
                  </h1>
                  <p className="max-w-2xl text-sm leading-6 text-zinc-400/90">
                    A dark realtime control room for OpenAI voice sessions and local Codex threads. The voice lane is live today,
                    and the Codex lane stays intact for the next step: wiring spoken intent into local coding workflows.
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        ) : null}

        <div className={paneOnlyMode ? "flex min-h-0 flex-1 flex-col" : "space-y-4"}>
          <div className={`grid items-stretch gap-4 md:grid-cols-2 ${paneOnlyMode ? "min-h-0 flex-1 auto-rows-fr" : ""}`}>
            <PanelShell
              title="Realtime Voice Agent"
              icon={<OpenAIWordmarkIcon />}
              headerRight={
                <RealtimeStatusBadge isMuted={isMicMuted} realtimeStatus={realtimeStatus} />
              }
              contentClassName={`flex flex-col space-y-4 ${paneOnlyMode ? "min-h-0 h-full" : "min-h-[36rem]"}`}
            >
              {realtimeStatus === "idle" || realtimeStatus === "error" ? (
                <div className="flex min-h-[11rem] items-center justify-center">
                  <Button
                    size="lg"
                    className="bg-[#b9f075] px-6 text-[#213024] hover:bg-[#c9f589]"
                    onClick={() => void handleStartRealtime()}
                  >
                    <Play className="size-5" />
                    Start Realtime Voice
                  </Button>
                </div>
              ) : (
                <>
                  <div className="flex min-h-10 flex-wrap items-center justify-between gap-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge className={`gap-2 ${panelBadgeClass()}`}>
                        <span className={`size-1.5 rounded-full ${statusDotClass(realtimeStatus)}`} />
                        {formatStatusLabel(realtimeStatus)}
                      </Badge>
                      {realtimeLastError ? (
                        <Badge variant="outline" className="max-w-full border-red-500/20 bg-red-950/20 text-red-200">
                          {realtimeLastError}
                        </Badge>
                      ) : null}
                    </div>

                    <div className="flex items-center gap-3">
                      <span className="text-[13px] font-medium text-zinc-500">
                        {realtimeConnectedAt ? formatDuration(realtimeElapsedSeconds) : "--:--"}
                      </span>
                      <Button
                        variant="outline"
                        className="h-8 rounded-full border border-white/12 bg-[#222925] px-3 text-[13px] font-medium text-zinc-200 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] hover:bg-[#28312b]"
                        onClick={() => void handleClearChat()}
                        title="Clear chat"
                      >
                        <Trash2 className="size-4" />
                        Clear chat
                      </Button>
                      <Button
                        variant="destructive"
                        className="h-8 rounded-full border border-red-400/35 bg-[#5a2e28] px-3 text-[13px] font-medium text-red-100 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] hover:bg-[#6a342d]"
                        onClick={() => {
                          const nextIntent = { ...persistedReconnectIntentRef.current, shouldReconnectRealtime: false };
                          persistedReconnectIntentRef.current = nextIntent;
                          writeStoredJson(STORAGE_KEYS.reconnectIntent, nextIntent);
                          disconnectRealtime();
                        }}
                        title="End call"
                      >
                        <PhoneOff className="size-4" />
                        End call
                      </Button>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 rounded-[1.1rem] border border-white/10 bg-[#1d2421] p-2 shadow-[0_14px_40px_rgba(0,0,0,0.26)]">
                    <button
                      type="button"
                      className={`flex size-10 shrink-0 items-center justify-center rounded-[0.9rem] border transition ${
                        !isMicMuted && realtimeStatus === "active"
                          ? "border-transparent bg-[#b9f075] text-black shadow-[0_0_0_4px_rgba(185,240,117,0.18)]"
                          : "border-white/10 bg-[#222925] text-zinc-100 hover:bg-[#272f2a]"
                      }`}
                      onClick={toggleMicMuted}
                      disabled={realtimeStatus !== "active"}
                      title={isMicMuted ? "Unmute Mic" : "Mute Mic"}
                    >
                      {isMicMuted ? <MicOff className="size-4.5" /> : <Mic className="size-4.5" />}
                    </button>
                    <input
                      ref={realtimeInputRef}
                      value={realtimeText}
                      onChange={(event) => setRealtimeText(event.target.value)}
                      className="h-10 min-w-0 flex-1 rounded-[0.95rem] border border-white/10 bg-[#222925] px-4 text-[15px] text-zinc-100 outline-none transition placeholder:text-zinc-500 focus:border-[#b9f075]/35 focus:ring-2 focus:ring-[#b9f075]/10"
                      placeholder="Type to the realtime session"
                      onKeyDown={(event) => {
                        if ((event.key === "Enter" && !event.shiftKey) || ((event.metaKey || event.ctrlKey) && event.key === "Enter")) {
                          event.preventDefault();
                          handleSendRealtimeText();
                        }
                        if (event.key === "Escape") {
                          setRealtimeText("");
                        }
                      }}
                    />
                    <button
                      type="button"
                      className="flex size-10 shrink-0 items-center justify-center rounded-[0.9rem] border border-white/10 bg-[#222925] text-zinc-200 transition hover:bg-[#272f2a] disabled:cursor-not-allowed disabled:opacity-40"
                      onClick={() => {
                        try {
                          skipAssistant();
                        } catch (error) {
                          console.error(error);
                        }
                      }}
                      disabled={!isAssistantSpeaking}
                      title="Skip assistant audio"
                    >
                      <SkipForward className="size-4" />
                    </button>
                    <button
                      type="button"
                      className="flex size-10 shrink-0 items-center justify-center rounded-[0.9rem] border border-white/10 bg-[#222925] text-zinc-200 transition hover:bg-[#272f2a] disabled:cursor-not-allowed disabled:opacity-40"
                      onClick={handleSendRealtimeText}
                      disabled={realtimeStatus !== "active" || !realtimeText.trim()}
                      title="Send Text"
                    >
                      <Send className="size-4" />
                    </button>
                  </div>
                </>
              )}

              {realtimeError ? (
                <div className="rounded-2xl border border-red-500/20 bg-red-950/30 px-4 py-3 text-sm text-red-200">
                  {realtimeError}
                </div>
              ) : null}

              <RealtimeConversationPanel messages={realtimeMessages} />
            </PanelShell>

            <PanelShell
              title="Codex"
              icon={<CodexWordmarkIcon />}
              headerRight={<CodexStatusBadge codexState={currentCodexState} />}
              contentClassName={`flex flex-col space-y-4 ${paneOnlyMode ? "min-h-0 h-full" : "min-h-[36rem]"}`}
            >
              <div className="flex min-h-10 flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge className={`gap-2 ${panelBadgeClass()}`}>
                    <span className={`size-1.5 rounded-full ${statusDotClass(status)}`} />
                    Codex {status}
                  </Badge>
                </div>

                <Button
                  variant="destructive"
                  className="h-8 rounded-full border border-red-400/35 bg-[#5a2e28] px-3 text-[13px] font-medium text-red-100 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] hover:bg-[#6a342d] disabled:cursor-not-allowed disabled:opacity-40"
                  onClick={() => {
                    if (!thread || activeTurnStatus !== "running") return;
                    void interruptTurn(thread.id).catch((error) => {
                      setThreadError((error as Error).message);
                    });
                  }}
                  disabled={!thread || activeTurnStatus !== "running"}
                  title="Interrupt Codex"
                >
                  <TerminalSquare className="size-4" />
                  Interrupt
                </Button>
              </div>

              {status === "connected" ? (
                <>
                  {thread ? (
                    <div className="flex min-h-0 flex-1 flex-col space-y-4">
                      <div className="flex items-center gap-2 rounded-[1.1rem] border border-white/10 bg-[#1d2421] p-2 shadow-[0_14px_40px_rgba(0,0,0,0.26)]">
                        <input
                          value={codexTaskText}
                          onChange={(event) => setCodexTaskText(event.target.value)}
                          className="h-10 min-w-0 flex-1 rounded-[0.95rem] border border-white/10 bg-[#222925] px-4 text-[15px] text-zinc-100 outline-none transition placeholder:text-zinc-500 focus:border-[#b9f075]/35 focus:ring-2 focus:ring-[#b9f075]/10"
                          placeholder="Type to the Codex thread"
                          onKeyDown={(event) => {
                            if ((event.key === "Enter" && !event.shiftKey) || ((event.metaKey || event.ctrlKey) && event.key === "Enter")) {
                              event.preventDefault();
                              void handleSendCodexTask();
                            }
                            if (event.key === "Escape") {
                              setCodexTaskText("");
                            }
                          }}
                        />
                        <button
                          type="button"
                          className="flex size-10 shrink-0 items-center justify-center rounded-[0.9rem] border border-white/10 bg-[#222925] text-zinc-200 transition hover:bg-[#272f2a] disabled:cursor-not-allowed disabled:opacity-40"
                          onClick={() => {
                            void handleSendCodexTask();
                          }}
                          disabled={activeTurnStatus === "running" && !activeTurnId}
                          title="Send Codex Task"
                        >
                          <Send className="size-4" />
                        </button>
                      </div>

                      <div className="min-h-0 flex-1">
                        <CodexConversationPanel messages={codexMessages} activeSegment={currentSegment} />
                      </div>
                    </div>
                  ) : (
                    <div className="rounded-xl border border-white/8 bg-[#171d1b] p-4 text-sm text-zinc-400">
                      Preparing Codex connection, logging in with the server API key, and starting the project thread.
                    </div>
                  )}
                </>
              ) : null}

              {authError ? (
                <div className="rounded-2xl border border-red-500/20 bg-red-950/30 px-4 py-3 text-sm text-red-200">
                  {authError}
                </div>
              ) : null}

              {threadError ? (
                <div className="rounded-2xl border border-red-500/20 bg-red-950/30 px-4 py-3 text-sm text-red-200">
                  {threadError}
                </div>
              ) : null}
            </PanelShell>
          </div>

          {!paneOnlyMode ? (
            <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
              <EventPanel events={agentEvents} />
              <RealtimeLogPanel entries={realtimeLogs} />
              <JsonRpcLogPanel entries={log} />
            </div>
          ) : null}
        </div>
      </div>
      {showExtraOverlay ? (
        <div className="pointer-events-none fixed bottom-4 right-4 z-[120]">
          <div className="pointer-events-auto flex items-center gap-3 rounded-2xl border border-white/10 bg-[#151b18]/95 px-3 py-3 shadow-[0_20px_60px_rgba(0,0,0,0.45)] backdrop-blur-md">
            <div className="hidden text-[11px] font-medium tracking-[0.12em] text-zinc-500 sm:block">
              DEBUG
            </div>
            <button
              type="button"
              className={`rounded-xl border border-white/10 bg-[#222925] p-2.5 text-zinc-100 transition hover:bg-[#2a332d] ${
                copyLogsState === "copied" ? "text-[#b9f075]" : copyLogsState === "error" ? "text-red-300" : ""
              }`}
              onClick={() => {
                void handleCopyLogs();
              }}
              title="Copy logs"
              aria-label="Copy logs"
            >
              <Copy className="size-4" />
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
