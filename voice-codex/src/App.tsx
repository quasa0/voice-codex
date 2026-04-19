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
  const projectPath =
    (typeof window !== "undefined" ? window.IDEBridge?.projectPath?.trim() : "") ||
    getCodexProjectCwd();
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
    `Current project path: ${projectPath}`,
    "Treat project/file/code requests as referring to this project by default.",
    "If the user says things like \"it\", \"that\", \"same thing\", \"make it bigger\", or a short numeric follow-up, interpret them relative to the most recent relevant coding task when plausible.",
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

function shouldForceCodexDispatch(text: string) {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return false;
  return (
    /^(?:literally\s+)?(?:please\s+)?(?:ask|tell)\s+codex\s+to\b/.test(normalized) ||
    /^(?:literally\s+)?(?:please\s+)?(?:ask|tell)\s+(?:it|him|the agent|the coding agent)\s+to\b/.test(normalized) ||
    /^(?:literally\s+)?(?:please\s+)?i\s+said\s+(?:ask|tell)\s+(?:codex|it|him|the agent|the coding agent)\s+to\b/.test(normalized)
  );
}

function buildManagedCodexRequest(originalText: string, normalizedText: string) {
  const projectPath =
    (typeof window !== "undefined" ? window.IDEBridge?.projectPath?.trim() : "") ||
    getCodexProjectCwd();
  const original = originalText.trim();
  const normalized = normalizedText.trim() || original;
  return [
    "<system_context>",
    "You are being managed by a Realtime Voice layer that may pass through the user's spoken words with routing wrappers.",
    "Treat the cleaned task below as the real user request.",
    "Do not focus on wrapper phrases like \"ask codex to\", \"tell codex to\", or similar orchestration language.",
    "If the original spoken utterance is ambiguous, prefer the cleaned task.",
    `Current project path: ${projectPath}`,
    "Assume project/file/code references are relative to that project unless the user says otherwise.",
    "</system_context>",
    "",
    "<original_spoken_utterance>",
    original,
    "</original_spoken_utterance>",
    "",
    "<cleaned_task>",
    normalized,
    "</cleaned_task>",
  ].join("\n");
}

type RecentCodexTaskContext = {
  segmentId: string;
  sourceUtterance: string;
  latestOutcome: string | null;
  latestMilestone: string | null;
  filesTouched: string[];
  codexState: CodexSegmentState;
};

function buildRecentCodexTaskContext(
  currentSegment: CodexSegment | null,
  segments: CodexSegment[],
): RecentCodexTaskContext | null {
  const relevantSegment =
    (currentSegment && segmentHasMeaningfulSummary(currentSegment) ? currentSegment : null) ??
    [...segments]
      .reverse()
      .find((segment) => segmentHasMeaningfulSummary(segment)) ??
    null;

  if (!relevantSegment) return null;

  return {
    segmentId: relevantSegment.id,
    sourceUtterance: relevantSegment.sourceUtterance.trim(),
    latestOutcome: getSegmentFirstLine(relevantSegment.finalOutcome),
    latestMilestone: getSegmentFirstLine(relevantSegment.latestMilestone),
    filesTouched: [...relevantSegment.filesEdited, ...relevantSegment.filesRead].slice(-4),
    codexState: relevantSegment.codexState,
  };
}

function looksLikeCodexFollowUp(text: string) {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return false;
  if (
    normalized.includes("what ") ||
    normalized.includes("why ") ||
    normalized.includes("how ") ||
    normalized.includes("did it") ||
    normalized.includes("is it") ||
    normalized.includes("are you") ||
    normalized.includes("remember") ||
    normalized.includes("history")
  ) {
    return false;
  }

  if (/^\d+(?:px|rem|em|%)?$/.test(normalized)) return true;
  if (/^(?:more|again|same thing|same|bigger|smaller|softer|warmer|cooler|brighter|darker)$/i.test(normalized)) {
    return true;
  }

  return (
    /^(?:and\s+)?(?:also\s+)?(?:make|set|change|keep|move|turn|remove|add|increase|decrease|raise|lower|push|nudge|try)\s+(?:it|that|this|them)\b/.test(normalized) ||
    /^(?:and\s+)?(?:also\s+)?(?:make|set|change|keep|move|turn|remove|add|increase|decrease|raise|lower|push|nudge|try)\s+.*\b(?:more|again|bigger|smaller|softer|warmer|cooler|brighter|darker)\b/.test(normalized) ||
    /^(?:and\s+)?(?:also\s+)?same thing\b/.test(normalized)
  );
}

function buildManagedCodexRequestWithContext(
  originalText: string,
  normalizedText: string,
  recentTaskContext: RecentCodexTaskContext | null,
  isFollowUp: boolean,
) {
  const baseRequest = buildManagedCodexRequest(originalText, normalizedText);
  if (!recentTaskContext || !isFollowUp) return baseRequest;

  const contextLines = [
    "",
    "<recent_task_context>",
    "Treat the cleaned task as a continuation or modification of the most recent relevant Codex task below unless the user clearly changed topic.",
    `Previous task: ${recentTaskContext.sourceUtterance}`,
  ];

  if (recentTaskContext.latestOutcome) {
    contextLines.push(`Latest outcome: ${recentTaskContext.latestOutcome}`);
  } else if (recentTaskContext.latestMilestone) {
    contextLines.push(`Latest milestone: ${recentTaskContext.latestMilestone}`);
  }

  if (recentTaskContext.filesTouched.length > 0) {
    contextLines.push(`Recent files touched: ${recentTaskContext.filesTouched.join(", ")}`);
  }

  contextLines.push("</recent_task_context>");
  return `${baseRequest}\n${contextLines.join("\n")}`;
}

function getRealtimeInputPlaceholder(
  realtimeStatus: OpenAIRealtimeStatus,
  isMicMuted: boolean,
) {
  if (realtimeStatus !== "active") {
    return "Start a call to use realtime voice";
  }

  if (isMicMuted) {
    return "Unmute to speak, or type to chat";
  }

  return "Speak or type to chat";
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

function shouldAvoidCodex(text: string) {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return false;
  return (
    /\b(?:dont|don't|do not|without)\s+(?:use\s+)?codex\b/.test(normalized) ||
    /\bno\s+codex\b/.test(normalized) ||
    /\bnot\s+codex\b/.test(normalized)
  );
}

function shouldForceChatOnly(text: string) {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return false;
  return (
    shouldAvoidCodex(text) ||
    /\bjust\s+(?:tell|answer|say|chat)\b/.test(normalized) ||
    /\byourself\b/.test(normalized) ||
    /\bno need to use codex\b/.test(normalized)
  );
}

function asksWhatYouKnowAboutProject(text: string) {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return false;
  return (
    normalized.includes("what do you know about project") ||
    normalized.includes("what do you know about the project") ||
    normalized.includes("what do you know about this project") ||
    normalized.includes("what do you know about our project") ||
    normalized.includes("what u know about project") ||
    normalized.includes("what u know about this project") ||
    normalized.includes("tell me what u know about project") ||
    normalized.includes("tell me what you know about project") ||
    normalized.includes("tell me what you know about this project") ||
    normalized.includes("tell me what u know about this project")
  );
}

function buildLocalProjectKnowledgeReply(userMessage: string, segments: CodexSegment[]) {
  if (!asksWhatYouKnowAboutProject(userMessage)) return null;

  const projectPath =
    (typeof window !== "undefined" ? window.IDEBridge?.projectPath?.trim() : "") ||
    getCodexProjectCwd();
  const latestMeaningfulSegment =
    [...segments].reverse().find((segment) => segmentHasMeaningfulSummary(segment)) ?? null;

  if (!latestMeaningfulSegment) {
    return `Without checking Codex: current project path is \`${projectPath}\`. I do not have inspected file or code details yet.`;
  }

  const latestKnownFact =
    getSegmentFirstLine(latestMeaningfulSegment.finalOutcome) ||
    getSegmentFirstLine(latestMeaningfulSegment.latestMilestone) ||
    getSegmentFirstLine(latestMeaningfulSegment.blockingQuestion);
  const touchedFiles =
    [...latestMeaningfulSegment.filesEdited, ...latestMeaningfulSegment.filesRead]
      .filter(Boolean)
      .slice(-4);

  return [
    `Without checking Codex: current project path is \`${projectPath}\`.`,
    latestKnownFact ? `Latest known context from this session: ${latestKnownFact}` : null,
    touchedFiles.length > 0 ? `Recent files mentioned: ${touchedFiles.join(", ")}.` : null,
  ]
    .filter(Boolean)
    .join(" ");
}

function asksWhatShouldIDo(text: string) {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return false;
  return (
    normalized === "what should i do" ||
    normalized === "what should i do?" ||
    normalized === "what do i do" ||
    normalized === "what do i do?" ||
    normalized.includes("what should i do next") ||
    normalized.includes("what do i do next")
  );
}

function buildLocalAdvisoryReply(userMessage: string, segments: CodexSegment[]) {
  if (!asksWhatShouldIDo(userMessage)) return null;

  const latestMeaningfulSegment =
    [...segments].reverse().find((segment) => segmentHasMeaningfulSummary(segment)) ?? null;
  const latestKnownFact =
    getSegmentFirstLine(latestMeaningfulSegment?.finalOutcome) ||
    getSegmentFirstLine(latestMeaningfulSegment?.latestMilestone) ||
    null;

  if (!latestKnownFact) {
    return "Two paths. If you want real project advice, let me inspect the code with Codex. If you want no Codex, ask what I know so far and I’ll stay local.";
  }

  return `Based on current session context: ${latestKnownFact} If you want better next steps, let me inspect more with Codex.`;
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

function summarizeActivityForStatus(activity: CodexSegmentActivity) {
  const summary = activity.summary.trim().replace(/\.$/, "");
  if (!summary) return null;

  if (activity.kind === "read") {
    return "read files";
  }

  if (activity.kind === "edit") {
    const file = formatActivityFileLabel(summary, undefined);
    return file ? `edited ${file}` : "edited files";
  }

  if (activity.kind === "command") {
    if (/\b(?:npm|pnpm|yarn)\s+(?:run\s+)?build\b/i.test(summary)) return "ran a build";
    if (/\b(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:test|lint|check|typecheck|validate)\b/i.test(summary)) return "ran checks";
    if (/\b(?:npm|pnpm|yarn)\s+install\b/i.test(summary)) return "installed packages";
    return "ran a command";
  }

  if (activity.kind === "plan") return "planned next steps";
  if (activity.kind === "error") return "hit an error";
  return summary.toLowerCase();
}

function buildRecentActivityOverview(segment: CodexSegment | null) {
  if (!segment) return null;

  const recentSteps = [...segment.activities]
    .reverse()
    .filter((activity) => activity.kind === "read" || activity.kind === "edit" || activity.kind === "command" || activity.kind === "plan")
    .map((activity) => summarizeActivityForStatus(activity))
    .filter((step): step is string => Boolean(step))
    .filter((step, index, array) => array.indexOf(step) === index)
    .slice(0, 3);

  if (recentSteps.length === 0) return null;
  if (recentSteps.length === 1) return `Recent step: ${recentSteps[0]}.`;
  if (recentSteps.length === 2) return `Recent steps: ${recentSteps[0]}, then ${recentSteps[1]}.`;
  return `Recent steps: ${recentSteps[0]}, then ${recentSteps[1]}, then ${recentSteps[2]}.`;
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

function inferAssistantProgressKind(text: string, fallbackKind?: CodexMessageKind | null) {
  if (fallbackKind && fallbackKind !== "reply") return fallbackKind;

  const lowered = text.trim().toLowerCase();
  if (!lowered) return null;

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

function getLatestSegmentAssistantProgress(segmentMessages: CodexMessage[]) {
  return [...segmentMessages]
    .reverse()
    .map((message) =>
      message.role === "assistant" && message.status === "final"
        ? { ...message, inferredKind: inferAssistantProgressKind(message.text, message.kind) }
        : null,
    )
    .find((message) => message?.inferredKind);
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

function normalizeRunningStatusSummary(text: string) {
  return text.trim().replace(/[.!?]+$/g, "").toLowerCase();
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

  if (latestProgressMessage?.inferredKind === "edit") {
    const latestEditedFile = formatActivityFileLabel(latestProgressMessage.text ?? "", segment.filesEdited.at(-1));
    return capSpeechReply(latestEditedFile ? `Editing ${latestEditedFile}.` : "Editing files.");
  }

  if (latestProgressMessage?.inferredKind === "plan") {
    return capSpeechReply("Planning next steps.");
  }

  if (latestProgressMessage?.inferredKind === "read") {
    return capSpeechReply("Reading files.");
  }

  const latestRelevantActivity = [...segment.activities]
    .reverse()
    .find((activity) => activity.kind === "edit" || activity.kind === "read" || activity.kind === "command" || activity.kind === "plan");

  if (latestRelevantActivity?.kind === "edit") {
    const latestEditedFile = formatActivityFileLabel(latestRelevantActivity.summary ?? "", segment.filesEdited.at(-1));
    return capSpeechReply(latestEditedFile ? `Editing ${latestEditedFile}.` : "Editing files.");
  }

  if (latestRelevantActivity?.kind === "read" || workingLabel === "reading files...") {
    return capSpeechReply("Reading files.");
  }

  if (latestRelevantActivity?.kind === "command" || workingLabel === "running checks..." || workingLabel === "running command...") {
    if (latestCommandLooksLikeBuild(latestCommand)) {
      return capSpeechReply("Running a build.");
    }
    if (latestCommandLooksLikeChecks(latestCommand)) {
      return capSpeechReply("Running checks.");
    }
    return capSpeechReply("Running a command.");
  }

  if (latestRelevantActivity?.kind === "plan") {
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
    const shortStatusText = summarizeRunningSegmentForSpeech(segment, segmentMessages);
    const normalizedShortStatus = normalizeRunningStatusSummary(shortStatusText);
    const recentOverview = buildRecentActivityOverview(segment);
    if (asksAboutTiming) {
      if (latestCommandLooksLikeBuild(latestCommand)) {
        return "Hard to tell exactly. Codex is running a build right now.";
      }
      if (latestCommandLooksLikeChecks(latestCommand)) {
        return "Hard to tell exactly. Codex is still running checks.";
      }
      return "Hard to tell exactly. Codex is still working.";
    }
    if (
      segment.lastUserCheckInAt &&
      unrelayedActivities.length === 0 &&
      segment.lastRelayedStatusSummary === normalizedShortStatus
    ) {
      const shortStatus = shortStatusText.replace(/\.$/, "");
      return `Still ${shortStatus.charAt(0).toLowerCase()}${shortStatus.slice(1)}, nothing new since you last asked.`.slice(0, 120);
    }
    if (recentOverview) {
      return `${shortStatusText} ${recentOverview}`.slice(0, 220);
    }
    return shortStatusText;
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
      className={`font-mono tracking-[0.04em] text-[#8a9099] ${className}`.trim()}
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
  if (kind === "edit") return "border border-[#c4e5d1] bg-[#e2f5ea] text-[#1e6b3f]";
  if (kind === "read") return "border border-[#c8dcf5] bg-[#e4efff] text-[#1f5da8]";
  if (kind === "command") return "border border-[#e1e4e8] bg-[#eceef1] text-[#4b4f55]";
  if (kind === "plan") return "border border-[#e1c8ec] bg-[#f1e4f7] text-[#7a3fa1]";
  if (kind === "error") return "border border-[#e7c6c6] bg-[#fbe5e5] text-[#8a2a2a]";
  return "border border-[#e1e4e8] bg-[#eceef1] text-[#4b4f55]";
}

function statusDotClass(status: string) {
  if (status === "connected" || status === "active" || status === "apiKey") return "bg-[#2fa860]";
  if (status === "connecting" || status === "requesting-mic") return "bg-[#9fcfb1]";
  if (status === "error") return "bg-[#c83f3f]";
  return "bg-[#c4c9cf]";
}

function eventToneClass(method?: string) {
  if (!method) return "text-[#8a9099]";
  if (method.startsWith("turn/")) return "text-[#1f2328]";
  if (method.startsWith("item/fileChange")) return "text-[#1e6b3f]";
  if (method.startsWith("item/commandExecution")) return "text-[#565c66]";
  if (method.startsWith("item/agentMessage")) return "text-[#1f2328]";
  if (method === "thread/realtime/sdp") return "text-[#1f5da8]";
  return "text-[#8a9099]";
}

function handoffEventClasses(kind?: "start" | "steer" | "interrupt" | "interrupted" | "refreshed") {
  if (kind === "interrupted" || kind === "refreshed") {
    return {
      badge: "border border-[#e1e4e8] bg-white text-[#8a9099]",
      text: "text-[#8a9099]",
    };
  }
  if (kind === "steer") {
    return {
      badge: "border border-[#c4e5d1] bg-[#e2f5ea] text-[#1e6b3f]",
      text: "text-[#1e6b3f]",
    };
  }
  if (kind === "interrupt") {
    return {
      badge: "border border-[#eccfb0] bg-[#fbefd9] text-[#8a5a1a]",
      text: "text-[#8a5a1a]",
    };
  }
  return {
    badge: "border border-[#eacfe0] bg-[#f7e9f2] text-[#8a3fa1]",
    text: "text-[#8a3fa1]",
  };
}

const STATUS_PILL_BAR_LEVELS = [0.3, 0.6, 0.85, 1, 0.7];
const STATUS_PILL_BAR_DELAYS = [0, 0.1, 0.2, 0.3, 0.4];

function RealtimeWaveBars({
  isMuted,
  isActive,
}: {
  isMuted: boolean;
  isActive: boolean;
}) {
  const active = isActive && !isMuted;

  return (
    <div className="flex h-[14px] w-full items-end justify-center gap-[2px]">
      {STATUS_PILL_BAR_LEVELS.map((height, index) => {
        const renderedHeight = Math.max(4, Math.round(14 * (active ? height : 0.3)));
        return (
          <span
            key={`${index}-${height}`}
            className={`rounded-full ${active ? "bg-[#2fa860]" : "bg-[#c4c9cf]"}`}
            style={{
              width: "2px",
              height: `${renderedHeight}px`,
              animation: active ? `status-pill-wave 1s ease-in-out ${STATUS_PILL_BAR_DELAYS[index]}s infinite` : "none",
              transformOrigin: "bottom",
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
  const label =
    realtimeStatus === "active"
      ? isMuted ? "Muted" : "Live"
      : realtimeStatus === "connecting"
        ? "Connecting"
        : realtimeStatus === "requesting-mic"
          ? "Requesting Mic"
          : "Off";
  const labelClass =
    realtimeStatus === "active"
      ? isMuted
        ? "font-medium text-[#c4c9cf]"
        : "font-semibold text-[#2fa860]"
      : realtimeStatus === "connecting" || realtimeStatus === "requesting-mic"
        ? "font-medium text-[#c77a1b]"
        : "font-medium text-[#4f5661]";

  return (
    <div className="flex h-9 w-[112px] items-center gap-2 rounded-full border border-transparent bg-white pl-0 pr-3 shadow-none">
      <div className="w-[28px]">
        <RealtimeWaveBars isMuted={isMuted} isActive={active} />
      </div>
      <div className={`text-[11.5px] leading-none ${labelClass}`}>{label}</div>
    </div>
  );
}

function CodexStatusGlyph({ codexState }: { codexState: CodexSegmentState }) {
  const active = codexState === "running";
  const waiting = codexState === "waiting_for_user";
  const failed = codexState === "failed";
  const dotClass = failed
    ? "bg-[#c83f3f]"
    : waiting
      ? "bg-[#c77a1b]"
      : active
        ? "bg-[#2fa860]"
        : "bg-[#c4c9cf]";

  return (
    <div className="flex h-[14px] w-[28px] items-center justify-center">
      <span
        className={`size-2 rounded-full ${dotClass} ${active ? "codex-working-dot" : ""}`}
      />
    </div>
  );
}

function CodexStatusBadge({
  codexState,
  activeSegment,
}: {
  codexState: CodexSegmentState;
  activeSegment: CodexSegment | null;
}) {
  const workingLabel = getSegmentWorkingLabel(activeSegment);
  const label =
    workingLabel === "idle"
      ? "Idle"
      : `${workingLabel.charAt(0).toUpperCase()}${workingLabel.slice(1)}`;
  const labelClass =
    codexState === "running"
      ? "font-semibold text-[#2fa860]"
      : codexState === "waiting_for_user"
        ? "font-medium text-[#c77a1b]"
        : codexState === "failed"
          ? "font-medium text-[#c83f3f]"
          : "font-medium text-[#c4c9cf]";

  return (
    <div className="flex h-9 max-w-[260px] items-center gap-2 rounded-full border border-transparent bg-white pl-0 pr-3 shadow-none">
      <CodexStatusGlyph codexState={codexState} />
      <div className={`min-w-0 truncate text-[11.5px] leading-none ${labelClass}`}>{label}</div>
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
    <svg
      fill="currentColor"
      fillRule="evenodd"
      viewBox="0 0 12 12"
      aria-hidden="true"
      className="size-4"
      style={{ flex: "none", lineHeight: 1 }}
    >
      <title>Codex</title>
      <path clipRule="evenodd" d="M4.04286 0.2285C4.52451 0.0305563 5.0488 -0.0408749 5.56586 0.0209996C6.23236 0.0974996 6.82636 0.381 7.34786 0.871C7.35488 0.877651 7.36344 0.882458 7.37278 0.884988C7.38212 0.887519 7.39194 0.887694 7.40136 0.8855C8.10536 0.7125 8.78236 0.7735 9.43186 1.0685L9.46336 1.0835L9.54036 1.1215C10.2189 1.473 10.7054 2.0065 10.9994 2.7205C11.1384 3.06 11.2084 3.4145 11.2099 3.7835C11.2197 4.05826 11.1893 4.33299 11.1199 4.599C11.1164 4.61256 11.1165 4.62676 11.12 4.6403C11.1235 4.65384 11.1303 4.66629 11.1399 4.6765C11.5329 5.07501 11.8063 5.57583 11.9289 6.122C12.1214 7.0725 11.9239 7.9295 11.3374 8.692L11.2464 8.802C10.8579 9.2468 10.3481 9.56847 9.77936 9.7275C9.76694 9.73108 9.75556 9.73757 9.74617 9.74645C9.73677 9.75532 9.72964 9.76631 9.72536 9.7785C9.59786 10.1465 9.46986 10.4605 9.23186 10.7745C8.63236 11.5655 7.75086 12.0055 6.75786 12C5.96636 11.996 5.26486 11.7065 4.65286 11.132C4.64358 11.1235 4.63225 11.1175 4.61998 11.1147C4.6077 11.1119 4.59491 11.1124 4.58286 11.116C4.32386 11.1995 4.06286 11.2115 3.78086 11.2085C3.33033 11.2049 2.88658 11.0985 2.48336 10.8975C2.0613 10.6882 1.6939 10.3832 1.41036 10.007C1.30886 9.8725 1.20836 9.746 1.13486 9.5965C1.03349 9.39043 0.95066 9.17575 0.887357 8.955C0.754446 8.45334 0.751521 7.9261 0.878857 7.423C0.882974 7.41113 0.884341 7.39848 0.882857 7.386C0.88038 7.37359 0.873877 7.36234 0.864357 7.354C0.556147 7.04224 0.320543 6.6663 0.174357 6.253C0.0775698 5.99853 0.0213841 5.73042 0.00785682 5.4585C-0.0163229 5.10044 0.0153902 4.7408 0.101857 4.3925C0.326857 3.6505 0.756357 3.0685 1.39036 2.646C1.53136 2.552 1.66536 2.479 1.79136 2.427C1.93436 2.367 2.07786 2.317 2.22186 2.275C2.23216 2.27195 2.24153 2.26637 2.24913 2.25877C2.25672 2.25117 2.2623 2.2418 2.26536 2.2315C2.37455 1.83899 2.56235 1.47275 2.81736 1.155C3.15736 0.731999 3.56586 0.423 4.04286 0.2285ZM3.64086 4.1535C3.58503 4.05583 3.49269 3.98435 3.38415 3.95476C3.27562 3.92518 3.15977 3.93992 3.06211 3.99575C2.96444 4.05158 2.89295 4.14392 2.86337 4.25245C2.83378 4.36099 2.84853 4.47683 2.90436 4.5745L3.75136 6.057L2.90736 7.481C2.85561 7.57749 2.84315 7.69024 2.87257 7.79571C2.902 7.90117 2.97104 7.99118 3.06526 8.04695C3.15949 8.10271 3.27162 8.11991 3.37823 8.09494C3.48484 8.06998 3.57768 8.0048 3.63736 7.913L4.60736 6.277C4.64561 6.21248 4.66609 6.13898 4.66671 6.06397C4.66732 5.98897 4.64805 5.91514 4.61086 5.85L3.64086 4.1535ZM6.36386 7.2735C6.25583 7.27993 6.15434 7.32737 6.08012 7.40614C6.00591 7.4849 5.96458 7.58903 5.96458 7.69725C5.96458 7.80547 6.00591 7.9096 6.08012 7.98836C6.15434 8.06712 6.25583 8.11457 6.36386 8.121H8.78786C8.89675 8.11571 8.99943 8.06873 9.07462 7.98979C9.14982 7.91086 9.19176 7.80602 9.19176 7.697C9.19176 7.58798 9.14982 7.48314 9.07462 7.40421C8.99943 7.32527 8.89675 7.27829 8.78786 7.273H6.36386V7.2735Z" />
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
    <Card className="h-full !gap-0 !py-0 rounded-none border-0 bg-white shadow-none">
      <CardHeader className="!gap-0 border-b border-[#EBEBEF] !px-2.5 !py-1">
        <div className="flex items-center justify-between gap-2.5">
          <div className="flex items-center gap-1.5">
            {icon ? (
              <div
                className={`flex size-6.5 items-center justify-center rounded-md border ${
                  title === "Codex"
                    ? "border-[#3a4048] bg-[#3a4048] text-white"
                    : "border-[#3a4048] bg-[#3a4048] text-white"
                }`}
              >
                {icon}
              </div>
            ) : null}
            <div>
              <CardTitle className="text-[13.5px] font-medium tracking-tight text-[#1f2328]">{title}</CardTitle>
              {description ? (
                <CardDescription className="text-[12px] leading-5 text-[#565c66]">{description}</CardDescription>
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
      <CardContent className={`!px-2.5 !py-1 ${contentClassName ?? ""}`.trim()}>{children}</CardContent>
    </Card>
  );
}

function PaneStatusRow({
  left,
  right,
}: {
  left: React.ReactNode;
  right: React.ReactNode;
}) {
  return (
    <div className="flex h-9 items-center justify-between gap-2">
      <div className="flex h-9 items-center gap-2">{left}</div>
      <div className="flex h-9 w-[237px] items-center justify-end gap-2.5">{right}</div>
    </div>
  );
}

function PaneComposerRow({
  leading,
  input,
  trailing,
}: {
  leading?: React.ReactNode;
  input: React.ReactNode;
  trailing?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-1.5 rounded-md bg-white">
      {leading}
      {input}
      {trailing}
    </div>
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
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTop = 0;
  }, [messages, activeSegment?.id, activeSegment?.updatedAt]);

  return (
    <div className="flex h-full min-h-0 flex-col rounded-md border border-[#EBEBEF] bg-[#f2f3f5] px-2 py-2">
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto pr-2 [scrollbar-gutter:stable]">
        <div className={messages.length === 0 ? "flex min-h-full items-center justify-center" : "flex flex-col-reverse gap-4"}>
          {messages.length === 0 ? (
            <div className="flex min-h-full items-center justify-center text-center">
              <div className="max-w-md space-y-2 px-6">
                <div className="text-[11px] uppercase tracking-[0.18em] text-[#8a9099]">conversation</div>
                <div className="text-[14px] text-[#565c66]">No Codex messages yet.</div>
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
                      className={`flex items-baseline gap-2 text-[11px] leading-none text-[#8a9099] ${
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
                          <span className="text-[#8a9099]">{codexMessagePhaseLabel(message)}</span>
                        )
                      ) : null}
                    </div>
                    <div
                      className="whitespace-pre-wrap text-[13.5px] leading-[1.6] text-[#1f2328]"
                    >
                      {message.text || "..."}
                      {message.role === "assistant" && message.status === "streaming" ? (
                        <span className="ml-1 inline-block h-[14px] w-[6px] animate-pulse align-[-2px] rounded-sm bg-[#2fa860]" />
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

function RealtimeConversationPanel({ messages }: { messages: RealtimeMessage[] }) {
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTop = 0;
  }, [messages]);

  return (
    <div className="flex h-full min-h-0 flex-col rounded-md border border-[#EBEBEF] bg-[#f2f3f5] px-2 py-2">
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto pr-2 [scrollbar-gutter:stable]">
        <div className={messages.length === 0 ? "flex min-h-full items-center justify-center" : "flex flex-col-reverse gap-4"}>
          {messages.length === 0 ? (
            <div className="flex min-h-full items-center justify-center text-center">
              <div className="max-w-md space-y-2 px-6">
                <div className="text-[11px] uppercase tracking-[0.18em] text-[#8a9099]">conversation</div>
                <div className="text-[14px] text-[#565c66]">No conversation messages yet.</div>
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
                      className={`flex items-baseline gap-2 text-[11px] leading-none text-[#8a9099] ${
                        message.role === "user" ? "justify-end" : "justify-start"
                      }`}
                    >
                      {message.role === "user" ? (
                        <span className="rounded-full border border-[#e1e4e8] bg-white px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.14em] text-[#565c66]">
                          {message.source}
                        </span>
                      ) : null}
                      <TimestampLabel timestamp={message.timestamp} />
                      {messagePhaseLabel(message) ? (
                        message.status === "streaming" ? (
                          <StreamingPhaseLabel label={messagePhaseLabel(message) ?? "streaming"} />
                        ) : (
                          <span className="text-[#8a9099]">{messagePhaseLabel(message)}</span>
                        )
                      ) : null}
                    </div>
                    <div
                      className="whitespace-pre-wrap text-[13.5px] leading-[1.6] text-[#1f2328]"
                    >
                      {message.text || "..."}
                      {message.role === "assistant" && message.status === "streaming" ? (
                        <span className="ml-1 inline-block h-[14px] w-[6px] animate-pulse align-[-2px] rounded-sm bg-[#2fa860]" />
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
  const queuedInterruptReplacementRef = useRef<{ relayRequest: string; codexRequest: string; segmentId: string } | null>(null);
  const pendingCodexNarrationRef = useRef<{ relayRequest: string; codexRequest: string; segmentId: string } | null>(null);
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

      const forceChatOnly = shouldForceChatOnly(latestFinalUserMessage.text);
      const exactLocalAdvisoryReply = forceChatOnly
        ? buildLocalAdvisoryReply(latestFinalUserMessage.text, segments)
        : null;
      if (exactLocalAdvisoryReply) {
        addDebugNote("relay_local_advice", `reply=${exactLocalAdvisoryReply}`);
        sendRealtimeText(
          `Say exactly this to the user and nothing else:\n${exactLocalAdvisoryReply}`,
          { requestResponse: true, visible: false },
        );
        return;
      }

      const exactLocalProjectReply = forceChatOnly
        ? buildLocalProjectKnowledgeReply(latestFinalUserMessage.text, segments)
        : null;
      if (exactLocalProjectReply) {
        addDebugNote("relay_local_project_context", `reply=${exactLocalProjectReply}`);
        sendRealtimeText(
          `Say exactly this to the user and nothing else:\n${exactLocalProjectReply}`,
          { requestResponse: true, visible: false },
        );
        return;
      }

      const forceCodexDispatch = shouldForceCodexDispatch(latestFinalUserMessage.text);
      const recentCodexTaskContext = buildRecentCodexTaskContext(currentSegment, segments);
      const continuationFollowUp =
        Boolean(recentCodexTaskContext) && looksLikeCodexFollowUp(latestFinalUserMessage.text);
      let routed = routeCacheRef.current.get(latestFinalUserMessage.id);
      if (!routed && !forceCodexDispatch && !forceChatOnly) {
        routed = await routeIntent(latestFinalUserMessage.text, currentCodexState === "running" || currentCodexState === "waiting_for_user");
        if (abortIfSuperseded()) return;
        routeCacheRef.current.set(latestFinalUserMessage.id, routed);
      }
      if (!routed && forceCodexDispatch) {
        routed = activeTurnStatus === "running"
          ? { action: "codex_steer", chat_mode: "normal", reason: "forced_wrapper_dispatch" }
          : { action: "codex_start", chat_mode: "normal", reason: "forced_wrapper_dispatch" };
      }
      if (!routed && forceChatOnly) {
        routed = { action: "chat_only", chat_mode: "normal", reason: "forced_chat_only" };
      }
      if ((!routed || routed.action === "chat_only") && continuationFollowUp && !forceChatOnly) {
        routed = activeTurnStatus === "running"
          ? { action: "codex_steer", chat_mode: "normal", reason: "follow_up_continuation" }
          : { action: "codex_start", chat_mode: "normal", reason: "follow_up_continuation" };
      }
      if (abortIfSuperseded()) return;
      if (!routed) return;

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
            const runningStatusSummary =
              currentSegment.codexState === "running"
                ? normalizeRunningStatusSummary(
                    summarizeRunningSegmentForSpeech(
                      currentSegment,
                      getSegmentMessages(codexMessages, currentSegment.id),
                    ),
                  )
                : null;
            if (currentSegment.blockingQuestion) {
              setSegmentRelayState(currentSegment.id, "clarification_spoken");
            } else if (currentSegment.codexState === "running") {
              setSegmentRelayState(currentSegment.id, "progress_spoken");
            }
            updateSegment(currentSegment.id, (seg) => ({
              ...seg,
              lastUserCheckInAt: formatNowLocal(0),
              lastRelayedActivityIndex: seg.activities.length - 1,
              lastRelayedStatusSummary: runningStatusSummary,
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
            (currentSegment && segmentHasMeaningfulSummary(currentSegment) ? currentSegment : null) ??
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
      const visibleCodexRequest = codexDispatchText || latestFinalUserMessage.text;
      const managedCodexRequest = buildManagedCodexRequestWithContext(
        latestFinalUserMessage.text,
        visibleCodexRequest,
        recentCodexTaskContext,
        continuationFollowUp,
      );
      addDebugNote(
        "codex_dispatch_text",
        `original=${latestFinalUserMessage.text}; normalized=${visibleCodexRequest}; follow_up=${continuationFollowUp ? "yes" : "no"}; context_segment=${recentCodexTaskContext?.segmentId ?? "none"}`,
      );

      let activeThread = thread;
      if (!activeThread) {
        if (!selectedModel) throw new Error("No valid Codex model loaded yet.");
        activeThread = await startThread(getCodexProjectCwd(), selectedModel);
        if (abortIfSuperseded()) return;
      }

      if (routed.action === "codex_interrupt" && activeTurnStatus === "running") {
        const segmentId = beginSegment("interrupt", latestFinalUserMessage.text);
        queuedInterruptReplacementRef.current = { relayRequest: visibleCodexRequest, codexRequest: managedCodexRequest, segmentId };
        pendingCodexNarrationRef.current = { relayRequest: visibleCodexRequest, codexRequest: managedCodexRequest, segmentId };
        await interruptTurn(activeThread.id);
        addRealtimeSystemMessage("interrupt", "interrupt");
        return;
      }

      if (routed.action === "codex_steer" && activeTurnStatus === "running" && activeTurnId) {
        const segmentId = beginSegment("steer", latestFinalUserMessage.text);
        pendingCodexNarrationRef.current = { relayRequest: visibleCodexRequest, codexRequest: managedCodexRequest, segmentId };
        await steerTurn(activeThread.id, managedCodexRequest, segmentId, visibleCodexRequest);
        addRealtimeSystemMessage("steer", "steer");
        return;
      }

      if (activeTurnStatus === "idle") {
        const segmentId = beginSegment("start", latestFinalUserMessage.text);
        pendingCodexNarrationRef.current = { relayRequest: visibleCodexRequest, codexRequest: managedCodexRequest, segmentId };
        await startTurn(activeThread.id, managedCodexRequest, segmentId, visibleCodexRequest);
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

    void startTurn(thread.id, replacement.codexRequest, replacement.segmentId, replacement.relayRequest).catch((error) => {
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
        `Codex finished a segment. Give the user a very short spoken summary of what changed or what Codex accomplished. Use only the structured segment summary below. Do not read raw command output. Do not repeat the user's wording. Keep it to one or two short sentences. End with one very short follow-up question, for example "Want tweaks?" No invention.\n\nOriginal user request:\n${pending.relayRequest}\n\nCodex segment summary:\n${JSON.stringify(buildSegmentSnapshot(targetSegment), null, 2)}\n\nCondensed status:\n${summarizeSegmentStatus(targetSegment, agentEvents)}`,
        { requestResponse: true, visible: false },
      );
      updateSegment(targetSegment.id, (seg) => ({
        ...seg,
        relayState: "completion_spoken",
        lastRelayedActivityIndex: seg.activities.length - 1,
        lastRelayedStatusSummary: null,
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
    <div className={`bg-[#f7f8fa] text-[#1f2328] ${paneOnlyMode ? "h-screen overflow-hidden" : "min-h-screen"}`}>
      <style>{`
        @keyframes streaming-label-pulse {
          0%, 100% { color: rgba(47, 168, 96, 0.72); text-shadow: 0 0 0 rgba(47, 168, 96, 0); }
          50% { color: rgba(47, 168, 96, 1); text-shadow: 0 0 10px rgba(47, 168, 96, 0.18); }
        }
        @keyframes streaming-dot-fade {
          0%, 20% { opacity: 0.18; }
          50% { opacity: 1; }
          100% { opacity: 0.18; }
        }
        @keyframes status-pill-wave {
          0%, 100% { transform: scaleY(.5); transform-origin: bottom; }
          50% { transform: scaleY(1); transform-origin: bottom; }
        }
        @keyframes codex-working-dot {
          0%, 100% { transform: scale(0.92); opacity: 0.68; box-shadow: 0 0 0 rgba(47,168,96,0); }
          50% { transform: scale(1.18); opacity: 1; box-shadow: 0 0 0 6px rgba(47,168,96,0.14); }
        }
        @keyframes codex-working-sheen {
          0% { transform: translateX(0); opacity: 0; }
          15% { opacity: 1; }
          55% { opacity: 1; }
          100% { transform: translateX(520%); opacity: 0; }
        }
        @keyframes codex-working-border {
          0%, 100% { border-color: rgba(225,228,232,1); background-color: rgba(255,255,255,1); }
          50% { border-color: rgba(196,229,209,1); background-color: rgba(226,245,234,0.6); }
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
      <div className={`flex flex-col gap-4 ${paneOnlyMode ? "h-full w-full px-0 py-0" : "mx-auto max-w-[1320px] px-3 py-4 sm:px-5 lg:px-6"}`}>
        {!paneOnlyMode ? (
          <Card className="overflow-hidden border border-[#EBEBEF] bg-white shadow-[0_1px_2px_rgba(18,22,28,0.04)]">
            <CardContent className="flex flex-col gap-4 px-4 py-4 lg:flex-row lg:items-center lg:justify-between">
              <div className="max-w-3xl space-y-3">
                <Badge variant="outline" className="border border-[#e1e4e8] bg-white text-[#565c66]">
                  Shack15 Hackathon Build
                </Badge>
                <div className="space-y-1.5">
                  <h1 className="text-2xl font-semibold tracking-tight text-[#1f2328] sm:text-3xl lg:text-[2.1rem]">
                    Voice Codex
                  </h1>
                  <p className="max-w-2xl text-sm leading-6 text-[#565c66]">
                    A dark realtime control room for OpenAI voice sessions and local Codex threads. The voice lane is live today,
                    and the Codex lane stays intact for the next step: wiring spoken intent into local coding workflows.
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        ) : null}

        <div className={paneOnlyMode ? "flex min-h-0 flex-1 flex-col" : "space-y-4"}>
          <div className={`grid items-stretch gap-0 bg-white md:grid-cols-2 md:divide-x md:divide-[#EBEBEF] ${paneOnlyMode ? "min-h-0 flex-1 auto-rows-fr" : "rounded-lg border border-[#EBEBEF] shadow-[0_1px_2px_rgba(18,22,28,0.04)]"}`}>
            <PanelShell
              title="Realtime Voice"
              icon={<OpenAIWordmarkIcon />}
              headerRight={
                <Badge
                  className={`h-7 justify-end gap-1 rounded-full px-2.5 text-[11.5px] font-medium ${
                    realtimeStatus === "active"
                      ? "border-transparent bg-[#f2f6f4] text-[#2fa860] shadow-none"
                      : realtimeStatus === "idle" || realtimeStatus === "error"
                        ? "border-transparent bg-[#fbf1f1] text-[#c83f3f] shadow-none"
                        : "border-transparent bg-[#fbefd9] text-[#c77a1b] shadow-none"
                  }`}
                >
                  {realtimeStatus === "active" ? "On" : realtimeStatus === "idle" || realtimeStatus === "error" ? "Off" : realtimeStatus === "requesting-mic" ? "Requesting" : formatStatusLabel(realtimeStatus)}
                  <span
                    className={`size-1.5 rounded-full ${
                      realtimeStatus === "active"
                        ? "bg-[#2fa860]"
                        : realtimeStatus === "idle" || realtimeStatus === "error"
                          ? "bg-[#c83f3f]"
                          : "bg-[#c77a1b]"
                    }`}
                  />
                </Badge>
              }
              contentClassName={`flex flex-col gap-2 ${paneOnlyMode ? "min-h-0 h-full" : "min-h-[36rem]"}`}
            >
              {(() => {
                const realtimeCallOff = realtimeStatus === "idle" || realtimeStatus === "error";
                const realtimeCanType = realtimeStatus === "active";

                return (
                  <>
                    <PaneStatusRow
                      left={
                        <>
                          {realtimeStatus === "active" ? (
                            <RealtimeStatusBadge
                              isMuted={isMicMuted}
                              realtimeStatus={realtimeStatus}
                            />
                          ) : null}
                          {realtimeLastError ? (
                            <Badge variant="outline" className="max-w-full border-red-500/20 bg-red-950/20 text-red-200">
                              {realtimeLastError}
                            </Badge>
                          ) : null}
                        </>
                      }
                      right={
                        <>
                          {realtimeConnectedAt && realtimeStatus === "active" ? (
                            <span className="text-[11.5px] font-medium text-[#565c66]">
                              {formatDuration(realtimeElapsedSeconds)}
                            </span>
                          ) : null}
                          <Button
                            variant="outline"
                            className="h-8 rounded-md border border-[#d3d7dc] bg-white px-3 text-[12px] font-medium text-[#1f2328] hover:bg-[#f2f3f5]"
                            onClick={() => void handleClearChat()}
                            title="Clear chat"
                          >
                            <Trash2 className="size-4" />
                            Clear chat
                          </Button>
                          {realtimeCallOff ? (
                            <Button
                              className="h-8 w-[106px] rounded-md border border-[#c4e5d1] bg-[#eef8f2] px-3 text-[12px] font-medium text-[#1e6b3f] hover:bg-[#e2f5ea]"
                              onClick={() => void handleStartRealtime()}
                              title="Start call"
                            >
                              <Play className="size-4" />
                              Start call
                            </Button>
                          ) : (
                            <Button
                              variant="destructive"
                              className="h-8 w-[106px] rounded-md border border-[#e7c6c6] bg-[#fbf1f1] px-3 text-[12px] font-medium text-[#8a2a2a] hover:bg-[#f6e2e2]"
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
                          )}
                        </>
                      }
                    />

                    <PaneComposerRow
                      leading={
                        <button
                          type="button"
                          className={`flex size-7.5 shrink-0 items-center justify-center rounded-md border transition ${
                            !isMicMuted && realtimeCanType
                              ? "border-[#c4e5d1] bg-[#e2f5ea] text-[#1e6b3f] shadow-[0_0_0_3px_rgba(47,168,96,0.18)]"
                              : "border-[#d3d7dc] bg-[#f7f8fa] text-[#9aa1ab]"
                          }`}
                          onClick={toggleMicMuted}
                          disabled={!realtimeCanType}
                          title={isMicMuted ? "Unmute Mic" : "Mute Mic"}
                        >
                          {isMicMuted ? <MicOff className="size-4.5" /> : <Mic className="size-4.5" />}
                        </button>
                      }
                      input={
                        <input
                          ref={realtimeInputRef}
                          value={realtimeText}
                          onChange={(event) => setRealtimeText(event.target.value)}
                          className={`h-[30px] min-w-0 flex-1 rounded-md border px-3 text-[13px] outline-none transition placeholder:text-[#8a9099] ${
                            realtimeCanType
                              ? "border-[#d3d7dc] bg-white text-[#1f2328] focus:border-[#2fa860] focus:ring-2 focus:ring-[#2fa860]/20"
                              : "border-[#d3d7dc] bg-[#f7f8fa] text-[#9aa1ab]"
                          }`}
                          placeholder={getRealtimeInputPlaceholder(realtimeStatus, isMicMuted)}
                          disabled={!realtimeCanType}
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
                      }
                      trailing={
                        <>
                          <button
                            type="button"
                            className={`flex size-7.5 shrink-0 items-center justify-center rounded-md border transition disabled:cursor-not-allowed disabled:opacity-40 ${
                              realtimeCanType
                                ? "border-[#d3d7dc] bg-white text-[#565c66] hover:bg-[#f2f3f5]"
                                : "border-[#d3d7dc] bg-[#f7f8fa] text-[#9aa1ab]"
                            }`}
                            onClick={() => {
                              try {
                                skipAssistant();
                              } catch (error) {
                                console.error(error);
                              }
                            }}
                            disabled={!realtimeCanType || !isAssistantSpeaking}
                            title="Skip assistant audio"
                          >
                            <SkipForward className="size-4" />
                          </button>
                          <button
                            type="button"
                            className={`flex size-7.5 shrink-0 items-center justify-center rounded-md border transition disabled:cursor-not-allowed disabled:opacity-40 ${
                              realtimeCanType
                                ? "border-[#d3d7dc] bg-white text-[#565c66] hover:bg-[#f2f3f5]"
                                : "border-[#d3d7dc] bg-[#f7f8fa] text-[#9aa1ab]"
                            }`}
                            onClick={handleSendRealtimeText}
                            disabled={!realtimeCanType || !realtimeText.trim()}
                            title="Send Text"
                          >
                            <Send className="size-4" />
                          </button>
                        </>
                      }
                    />
                  </>
                );
              })()}

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
              headerRight={
                <Badge
                  className={`h-7 justify-end gap-1 rounded-full px-2.5 text-[11.5px] font-medium ${
                    status === "connected"
                      ? "border-transparent bg-[#f2f6f4] text-[#2fa860] shadow-none"
                      : status === "error"
                        ? "border-transparent bg-[#fbf1f1] text-[#c83f3f] shadow-none"
                        : "border-transparent bg-[#fbefd9] text-[#c77a1b] shadow-none"
                  }`}
                >
                  {status === "connected" ? "Connected" : formatStatusLabel(status)}
                  <span className={`size-1.5 rounded-full ${statusDotClass(status)}`} />
                </Badge>
              }
              contentClassName={`flex flex-col gap-2 ${paneOnlyMode ? "min-h-0 h-full" : "min-h-[36rem]"}`}
            >
              <PaneStatusRow
                left={
                  <CodexStatusBadge
                    codexState={status === "connected" ? currentCodexState : "idle"}
                    activeSegment={status === "connected" ? currentSegment : null}
                  />
                }
                right={
                  <Button
                    variant="destructive"
                    className="h-8 rounded-md border border-[#e7c6c6] bg-[#fbf1f1] px-3 text-[12px] font-medium text-[#8a2a2a] hover:bg-[#f6e2e2] disabled:cursor-not-allowed disabled:opacity-40"
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
                }
              />

              {status === "connected" ? (
                <>
                  {thread ? (
                    <>
                      <PaneComposerRow
                        input={
                          <input
                            value={codexTaskText}
                            onChange={(event) => setCodexTaskText(event.target.value)}
                            className="h-[30px] min-w-0 flex-1 rounded-md border border-[#d3d7dc] bg-white px-3 text-[13px] text-[#1f2328] outline-none transition placeholder:text-[#8a9099] focus:border-[#2fa860] focus:ring-2 focus:ring-[#2fa860]/20"
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
                        }
                        trailing={
                          <button
                            type="button"
                            className="flex size-7.5 shrink-0 items-center justify-center rounded-md border border-[#d3d7dc] bg-white text-[#565c66] transition hover:bg-[#f2f3f5] disabled:cursor-not-allowed disabled:opacity-40"
                            onClick={() => {
                              void handleSendCodexTask();
                            }}
                            disabled={activeTurnStatus === "running" && !activeTurnId}
                            title="Send Codex Task"
                          >
                            <Send className="size-4" />
                          </button>
                        }
                      />

                      <div className="min-h-0 flex-1">
                        <CodexConversationPanel messages={codexMessages} activeSegment={currentSegment} />
                      </div>
                    </>
                  ) : (
                    <div className="rounded-md border border-[#e1e4e8] bg-[#f7f8fa] p-4 text-sm text-[#565c66]">
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
          <div className="pointer-events-auto flex items-center gap-3 rounded-xl border border-[#e1e4e8] bg-white/95 px-3 py-3 shadow-[0_8px_20px_rgba(18,22,28,0.08)] backdrop-blur-md">
            <div className="hidden text-[11px] font-medium tracking-[0.12em] text-[#8a9099] sm:block">
              DEBUG
            </div>
            <button
              type="button"
              className={`rounded-md border border-[#d3d7dc] bg-white p-2.5 text-[#565c66] transition hover:bg-[#f2f3f5] ${
                copyLogsState === "copied" ? "text-[#2fa860]" : copyLogsState === "error" ? "text-[#c83f3f]" : ""
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
