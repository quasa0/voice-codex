import { useEffect, useRef, useState } from "react";
import { Activity, Cable, Mic, MicOff, Play, Radio, Send, SkipForward, Square, TerminalSquare, WandSparkles } from "lucide-react";
import { useCodexWebSocket } from "./useCodexWebSocket";
import { useOpenAIRealtime } from "./useOpenAIRealtime";
import type { LogEntry, AgentEvent, ModelInfo, CodexMessage } from "./types";
import { CODEX_PROJECT_CWD } from "./codexConfig";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
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
  eventKind?: "start" | "steer" | "interrupt";
};

type CodexIntentAction = "chat_only" | "codex_start" | "codex_steer" | "codex_interrupt";
type RoutedIntent = {
  action: CodexIntentAction;
  chat_mode: "normal" | "relay_latest_codex" | "relay_codex_status";
  reason: string;
};

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

function summarizeCurrentCodexActivity(
  activeTurnStatus: "idle" | "running" | "error",
  agentEvents: AgentEvent[],
  codexMessages: CodexMessage[],
) {
  const recentEvents = [...agentEvents].reverse();
  const latestPlan = recentEvents.find((event) => event.method === "turn/plan/updated");
  const recentCommandSummary = summarizeRecentCommands(agentEvents);

  if (activeTurnStatus !== "running") {
    const latestCodexReply = [...codexMessages]
      .reverse()
      .find((message) => message.role === "assistant" && message.status === "final" && message.text.trim());

    if (recentCommandSummary && latestCodexReply) {
      const firstLine = latestCodexReply.text.trim().split("\n").find(Boolean) ?? latestCodexReply.text.trim();
      return `Codex is idle. ${recentCommandSummary} Latest result: ${firstLine}`.slice(0, 420);
    }

    if (latestCodexReply) {
      const firstLine = latestCodexReply.text.trim().split("\n").find(Boolean) ?? latestCodexReply.text.trim();
      return `Codex is idle. Latest result: ${firstLine}`.slice(0, 320);
    }

    if (recentCommandSummary) {
      return `Codex is idle. ${recentCommandSummary}`.slice(0, 320);
    }

    return "Codex is idle right now.";
  }

  const latestCommand = recentEvents.find(
    (event) =>
      event.method === "item/started" &&
      typeof (event.raw as { item?: { type?: string } })?.item?.type === "string" &&
      (event.raw as { item?: { type?: string } }).item?.type === "commandExecution",
  );
  const latestAssistant = [...codexMessages]
    .reverse()
    .find((message) => message.role === "assistant" && message.text.trim());

  if (latestPlan?.summary && recentCommandSummary) {
    return `Codex is working. ${recentCommandSummary} ${latestPlan.summary}`.slice(0, 420);
  }

  if (latestPlan?.summary) {
    return `Codex is working. ${latestPlan.summary}`.slice(0, 320);
  }

  if (recentCommandSummary && latestCommand?.summary) {
    return `Codex is working. ${recentCommandSummary} ${latestCommand.summary}`.slice(0, 360);
  }

  if (recentCommandSummary) {
    return `Codex is working. ${recentCommandSummary}`.slice(0, 320);
  }

  if (latestCommand?.summary) {
    return `Codex is working. ${latestCommand.summary}`.slice(0, 320);
  }

  if (latestAssistant?.text) {
    const firstLine = latestAssistant.text.trim().split("\n").find(Boolean) ?? latestAssistant.text.trim();
    return `Codex is working. ${firstLine}`.slice(0, 320);
  }

  return "Codex is working right now.";
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
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return timestamp;
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
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

function statusDotClass(status: string) {
  if (status === "connected" || status === "active" || status === "apiKey") return "bg-[#b9f075]";
  if (status === "connecting" || status === "requesting-mic") return "bg-[#d0ef9e]";
  if (status === "error") return "bg-red-300";
  return "bg-zinc-400";
}

function panelBadgeClass() {
  return "h-8 rounded-full border-[#b9f075]/20 bg-[#b9f075]/10 px-3 text-[13px] font-medium text-[#d8f5ab]";
}

function turnBadgeClass(status: "idle" | "running" | "error") {
  if (status === "running") {
    return "h-10 rounded-full border-[#b9f075]/25 bg-[#b9f075]/14 px-4 text-[14px] font-semibold text-[#ecffd0]";
  }
  if (status === "error") {
    return "h-10 rounded-full border-red-500/30 bg-red-500/14 px-4 text-[14px] font-semibold text-red-100";
  }
  return "h-10 rounded-full border-white/12 bg-white/[0.05] px-4 text-[14px] font-semibold text-zinc-100";
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

function handoffEventClasses(kind?: "start" | "steer" | "interrupt") {
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

function CodexConversationPanel({ messages }: { messages: CodexMessage[] }) {
  return (
    <div className="flex h-full min-h-0 flex-col rounded-xl border border-white/8 bg-[#171d1b] p-3">
      <ScrollArea className="min-h-0 flex-1 pr-3">
        <div className={messages.length === 0 ? "flex min-h-full items-center justify-center" : "flex flex-col-reverse gap-1.5"}>
          {messages.length === 0 ? (
            <div className="flex w-full max-w-md items-center justify-center rounded-2xl border border-dashed border-white/8 bg-white/[0.02] px-6 py-8 text-center text-sm text-zinc-500">
              No Codex messages yet.
            </div>
          ) : (
            messages.map((message) => (
              <div
                key={message.id}
                className={`py-2 ${
                  message.role === "assistant"
                    ? "text-left"
                    : message.role === "system"
                      ? "text-left"
                      : "text-right"
                }`}
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
                    <span className="absolute right-0 text-[10px] uppercase tracking-[0.16em] text-zinc-500">
                      {formatLocalTime(message.timestamp)}
                    </span>
                  </div>
                ) : (
                  <div className={`space-y-1 ${message.role === "assistant" ? "mr-12" : "ml-12"}`}>
                    <div
                      className={`flex flex-wrap gap-x-3 gap-y-1 text-[10px] uppercase tracking-[0.16em] text-zinc-500 ${
                        message.role === "assistant" ? "justify-start" : "justify-end"
                      }`}
                    >
                      {codexMessagePhaseLabel(message) ? <span>{codexMessagePhaseLabel(message)}</span> : null}
                      <span>{formatLocalTime(message.timestamp)}</span>
                    </div>
                    <div className="whitespace-pre-wrap text-[13px] leading-5 text-zinc-100">
                      {message.text || "..."}
                    </div>
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

function ConversationPanel({ messages }: { messages: RealtimeMessage[] }) {
  return (
    <div className="flex h-full min-h-0 flex-col rounded-xl border border-white/8 bg-[#171d1b] p-3">
      <ScrollArea className="min-h-0 flex-1 pr-3">
        <div className={messages.length === 0 ? "flex min-h-full items-center justify-center" : "flex flex-col-reverse gap-1.5"}>
          {messages.length === 0 ? (
            <div className="flex w-full max-w-md items-center justify-center rounded-2xl border border-dashed border-white/8 bg-white/[0.02] px-6 py-8 text-center text-sm text-zinc-500">
              No conversation messages yet.
            </div>
          ) : (
            messages.map((message) => (
              <div
                key={message.id}
                className={`py-2 ${
                  message.role === "assistant"
                    ? "text-left"
                    : message.role === "system"
                      ? "text-left"
                      : "text-right"
                }`}
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
                    <span className="absolute right-0 text-[10px] uppercase tracking-[0.16em] text-zinc-500">
                      {formatLocalTime(message.timestamp)}
                    </span>
                  </div>
                ) : (
                  <div className={`space-y-1 ${message.role === "assistant" ? "mr-12" : "ml-12"}`}>
                    <div
                      className={`flex flex-wrap gap-x-3 gap-y-1 text-[10px] uppercase tracking-[0.16em] text-zinc-500 ${
                        message.role === "assistant" ? "justify-start" : "justify-end"
                      }`}
                    >
                      <span>{message.source}</span>
                      {messagePhaseLabel(message) ? <span>{messagePhaseLabel(message)}</span> : null}
                      <span>{formatLocalTime(message.timestamp)}</span>
                    </div>
                    <div className="whitespace-pre-wrap text-[13px] leading-5 text-zinc-100">
                      {message.text || "..."}
                    </div>
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

function pickDefaultModel(models: ModelInfo[]) {
  const realtimeCandidate = models.find((model) => model.id.toLowerCase().includes("realtime"));
  return realtimeCandidate?.id ?? models[0]?.id ?? "";
}

export default function App() {
  const [wsUrl] = useState("ws://localhost:3001?target=ws://127.0.0.1:3000");
  const [selectedModel, setSelectedModel] = useState("");
  const [realtimeText, setRealtimeText] = useState("");
  const [authError, setAuthError] = useState<string | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [codexTaskText, setCodexTaskText] = useState("");

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
    activeTurnStatus,
    activeTurnId,
    startTurn,
    steerTurn,
    interruptTurn,
    addSystemMessage,
  } = useCodexWebSocket();

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
  } = useOpenAIRealtime();

  const sdpHandlerRef = useRef<((sdp: string) => void) | null>(null);
  const realtimeInputRef = useRef<HTMLInputElement | null>(null);
  const prevEventCount = useRef(0);
  const lastHandledRealtimeMessageIdRef = useRef<string | null>(null);
  const routeCacheRef = useRef(new Map<string, RoutedIntent>());
  const queuedInterruptReplacementRef = useRef<string | null>(null);
  const pendingCodexNarrationRef = useRef<{ request: string; turnId?: string | null } | null>(null);
  const lastNarratedCodexMessageIdRef = useRef<string | null>(null);
  const codexBootstrapAttemptedRef = useRef(false);
  const realtimeBootstrapAttemptedRef = useRef(false);
  const [threadError, setThreadError] = useState<string | null>(null);

  const routeIntent = async (message: string, codexRunning: boolean): Promise<RoutedIntent> => {
    const latestCodexReply = [...codexMessages]
      .reverse()
      .find((entry) => entry.role === "assistant" && entry.status === "final");
    const recentConversation = realtimeMessages
      .slice(-6)
      .map((entry) => ({ role: entry.role, text: entry.text }));

    const response = await fetch("/__intent/route", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message,
        codexRunning,
        latestCodexReply: latestCodexReply?.text ?? null,
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
      await startThread(CODEX_PROJECT_CWD, selectedModel);
    } catch (error) {
      setThreadError((error as Error).message);
    }
  };

  const handleStartRealtime = async () => {
    await connectRealtime({
      model: "gpt-realtime",
      voice: "marin",
      instructions:
        `You are voice coding assistant inside an already-open software project. Project workspace already known and connected to Codex. Do not ask user for repo name, folder, project structure, or what files exist unless truly impossible. For requests about files, codebase structure, repo contents, implementation details, or inspection, default to delegating to Codex. Do not claim you already queried Codex unless frontend actually dispatched Codex work. If delegation not yet confirmed, say brief handoff like "Checking Codex now." Never make up project facts, implementation details, files, components, APIs, or what Codex built. If the answer is unclear from explicit context already provided in conversation, say you need to check Codex or ask a brief clarifying question instead of guessing. Use user only for product intent, ambiguity, or preference decisions. Speak only English unless user explicitly asks another language. Wait until user finishes speaking before replying. ${TERSE_AGENT_STYLE}`,
    });
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
    if (realtimeBootstrapAttemptedRef.current) return;
    if (realtimeStatus !== "idle") return;
    realtimeBootstrapAttemptedRef.current = true;
    void handleStartRealtime().catch((error) => {
      console.error(error);
    });
  }, [realtimeStatus]);

  useEffect(() => {
    if (codexBootstrapAttemptedRef.current) return;
    codexBootstrapAttemptedRef.current = true;
    connect(wsUrl);
  }, [connect, wsUrl]);

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
    if (lastHandledRealtimeMessageIdRef.current === latestFinalUserMessage.id) return;

    lastHandledRealtimeMessageIdRef.current = latestFinalUserMessage.id;

    const dispatch = async () => {
      let routed = routeCacheRef.current.get(latestFinalUserMessage.id);
      if (!routed) {
        routed = await routeIntent(latestFinalUserMessage.text, activeTurnStatus === "running");
        routeCacheRef.current.set(latestFinalUserMessage.id, routed);
      }

      if (routed.action === "chat_only") {
        if (routed.chat_mode === "relay_codex_status") {
          const codexStatus = summarizeCurrentCodexActivity(activeTurnStatus, agentEvents, codexMessages);
          sendRealtimeText(
            `Summarize current Codex activity for the user in one or two short sentences. Include what Codex is doing now and, if available, the main files or steps it has already touched. Do not repeat the user's wording. Do not invent details.\n\nCurrent Codex status:\n${codexStatus}`,
            { requestResponse: true, visible: false },
          );
          return;
        }

        if (routed.chat_mode === "relay_latest_codex") {
          const latestCodexReply = [...codexMessages]
            .reverse()
            .find((message) => message.role === "assistant" && message.status === "final");
          if (latestCodexReply) {
            sendRealtimeText(
              `Codex result available. Relay exact substance to user. No invention. Be terse.\n\nUser asked: ${latestFinalUserMessage.text}\n\nCodex result:\n${latestCodexReply.text}`,
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

      let activeThread = thread;
      if (!activeThread) {
        if (!selectedModel) throw new Error("No valid Codex model loaded yet.");
        activeThread = await startThread(CODEX_PROJECT_CWD, selectedModel);
      }

      if (routed.action === "codex_interrupt" && activeTurnStatus === "running") {
        queuedInterruptReplacementRef.current = latestFinalUserMessage.text;
        pendingCodexNarrationRef.current = null;
        await interruptTurn(activeThread.id);
        addSystemMessage("interrupt", "interrupt");
        addRealtimeSystemMessage("interrupt", "interrupt");
        return;
      }

      if (routed.action === "codex_steer" && activeTurnStatus === "running" && activeTurnId) {
        pendingCodexNarrationRef.current = { request: latestFinalUserMessage.text, turnId: activeTurnId };
        await steerTurn(activeThread.id, latestFinalUserMessage.text);
        addSystemMessage("steer", "steer");
        addRealtimeSystemMessage("steer", "steer");
        return;
      }

      if (activeTurnStatus === "idle") {
        pendingCodexNarrationRef.current = { request: latestFinalUserMessage.text, turnId: null };
        await startTurn(activeThread.id, latestFinalUserMessage.text);
        addSystemMessage("new turn", "start");
        addRealtimeSystemMessage("new turn", "start");
      }
    };

    void dispatch().catch((error) => {
      setThreadError((error as Error).message);
    });
  }, [
    activeTurnId,
    activeTurnStatus,
    addSystemMessage,
    addRealtimeSystemMessage,
    agentEvents,
    codexMessages,
    interruptTurn,
    realtimeMessages,
    requestRealtimeResponse,
    selectedModel,
    sendRealtimeText,
    startThread,
    startTurn,
    status,
    steerTurn,
    thread,
  ]);

  useEffect(() => {
    if (!pendingCodexNarrationRef.current) return;
    if (pendingCodexNarrationRef.current.turnId) return;
    if (!activeTurnId) return;

    pendingCodexNarrationRef.current = {
      ...pendingCodexNarrationRef.current,
      turnId: activeTurnId,
    };
  }, [activeTurnId]);

  useEffect(() => {
    if (activeTurnStatus !== "idle" || !thread || !queuedInterruptReplacementRef.current) return;

    const replacement = queuedInterruptReplacementRef.current;
    queuedInterruptReplacementRef.current = null;
    pendingCodexNarrationRef.current = { request: replacement, turnId: null };

    void startTurn(thread.id, replacement).catch((error) => {
      setThreadError((error as Error).message);
    });
  }, [activeTurnStatus, startTurn, thread]);

  useEffect(() => {
    if (activeTurnStatus !== "idle") return;
    if (queuedInterruptReplacementRef.current) return;
    if (!pendingCodexNarrationRef.current) return;

    const pending = pendingCodexNarrationRef.current;
    const latestCodexReply = [...codexMessages]
      .reverse()
      .find(
        (message) =>
          message.role === "assistant" &&
          message.status === "final" &&
          (!pending.turnId || message.turnId === pending.turnId),
      );

    if (!latestCodexReply) return;
    if (lastNarratedCodexMessageIdRef.current === latestCodexReply.id) return;

    pendingCodexNarrationRef.current = null;
    lastNarratedCodexMessageIdRef.current = latestCodexReply.id;

    try {
      sendRealtimeText(
        `Codex finished. Relay result to user. Use only Codex result. No invention. If short, keep short. If list, read compactly.\n\nOriginal user request:\n${pending.request}\n\nCodex result:\n${latestCodexReply.text}`,
        { requestResponse: true, visible: false },
      );
    } catch (error) {
      console.error(error);
    }
  }, [activeTurnStatus, codexMessages, sendRealtimeText]);

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
        activeThread = await startThread(CODEX_PROJECT_CWD, selectedModel);
      }
      await startTurn(activeThread.id, task);
      setCodexTaskText("");
    } catch (error) {
      setThreadError((error as Error).message);
    }
  };

  return (
    <div className="dark min-h-screen bg-transparent text-zinc-50">
      <div className="mx-auto flex max-w-[1180px] flex-col gap-4 px-3 py-4 sm:px-5 lg:px-6">
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

        <div className="space-y-4">
          <div className="grid items-stretch gap-4 md:grid-cols-2">
            <PanelShell
              title="OpenAI Realtime"
              description="Direct voice lane over the OpenAI Realtime API."
              icon={<WandSparkles className="size-4" />}
              headerRight={
                <Badge className={`gap-2 ${turnBadgeClass(isMicMuted ? "idle" : "running")}`}>
                  <span className={`size-2 rounded-full ${statusDotClass(isMicMuted ? "idle" : "active")}`} />
                  {isMicMuted ? "muted" : "live"}
                </Badge>
              }
              contentClassName="flex min-h-[36rem] flex-col space-y-4"
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
                        {realtimeStatus}
                      </Badge>
                      <Badge variant="outline" className={panelBadgeClass()}>
                        {realtimeConnectedAt ? formatDuration(realtimeElapsedSeconds) : "--:--"}
                      </Badge>
                      {realtimeLastError ? (
                        <Badge variant="outline" className="max-w-full border-red-500/20 bg-red-950/20 text-red-200">
                          {realtimeLastError}
                        </Badge>
                      ) : null}
                    </div>

                    <Button
                      variant="destructive"
                      className="h-10 rounded-full border-red-500/22 bg-[#5a2e28] px-4 text-red-100 hover:bg-[#6a342d]"
                      onClick={() => disconnectRealtime()}
                      title="End call"
                    >
                      <Square className="size-4" />
                      End call
                    </Button>
                  </div>

                  <div className="flex items-center gap-2.5 rounded-[1.45rem] border border-white/8 bg-[#202824]/70 p-1.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
                    <Button
                      size="icon-lg"
                      className="size-12 shrink-0 rounded-[1rem] border border-[#d6ff96]/35 bg-[#b9f075] text-[#213024] shadow-[0_8px_20px_rgba(185,240,117,0.16)] hover:bg-[#c9f589]"
                      onClick={toggleMicMuted}
                      disabled={realtimeStatus !== "active"}
                      title={isMicMuted ? "Unmute Mic" : "Mute Mic"}
                    >
                      {isMicMuted ? <Mic className="size-4.5" /> : <MicOff className="size-4.5" />}
                    </Button>
                    <Input
                      ref={realtimeInputRef}
                      value={realtimeText}
                      onChange={(event) => setRealtimeText(event.target.value)}
                      className="h-12 flex-1 rounded-[1.1rem] border-white/10 bg-[#1f2623] px-5 text-[0.98rem] text-zinc-100 placeholder:text-zinc-500 focus-visible:border-[#b9f075]/35 focus-visible:ring-[#b9f075]/15"
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
                    <Button
                      size="default"
                      variant="outline"
                      className="h-12 shrink-0 rounded-[1rem] border-white/10 bg-[#1f2623] px-4 text-zinc-100 hover:bg-[#252d29]"
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
                      Skip
                    </Button>
                    <Button
                      size="icon-lg"
                      variant="outline"
                      className="size-12 shrink-0 rounded-[1rem] border-white/10 bg-[#1f2623] text-zinc-100 hover:bg-[#252d29]"
                      onClick={handleSendRealtimeText}
                      disabled={realtimeStatus !== "active"}
                      title="Send Text"
                    >
                      <Send className="size-4.5" />
                    </Button>
                  </div>
                </>
              )}

              {realtimeError ? (
                <div className="rounded-2xl border border-red-500/20 bg-red-950/30 px-4 py-3 text-sm text-red-200">
                  {realtimeError}
                </div>
              ) : null}

              <ConversationPanel messages={realtimeMessages} />
            </PanelShell>

            <PanelShell
              title="Codex App Server"
              description="Local Codex agent."
              icon={<Cable className="size-4" />}
              headerRight={
                <Badge className={`gap-2 ${turnBadgeClass(activeTurnStatus)}`}>
                  <span className={`size-2 rounded-full ${statusDotClass(activeTurnStatus === "running" ? "active" : activeTurnStatus)}`} />
                  Turn {activeTurnStatus}
                </Badge>
              }
              contentClassName="flex min-h-[36rem] flex-col space-y-4"
            >
              <div className="flex min-h-10 flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge className={`gap-2 ${panelBadgeClass()}`}>
                    <span className={`size-1.5 rounded-full ${statusDotClass(status)}`} />
                    Codex {status}
                  </Badge>
                  {account?.type ? (
                    <Badge variant="outline" className={panelBadgeClass()}>
                      API
                    </Badge>
                  ) : null}
                </div>

                <div
                  aria-hidden="true"
                  className="h-10 rounded-full px-4 opacity-0 pointer-events-none select-none"
                >
                  End call
                </div>
              </div>

              {status === "connected" ? (
                <>
                  {thread ? (
                    <div className="flex min-h-0 flex-1 flex-col space-y-4">
                      <div className="flex items-center gap-2.5 rounded-[1.45rem] border border-white/8 bg-[#202824]/70 p-1.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
                        <Input
                          value={codexTaskText}
                          onChange={(event) => setCodexTaskText(event.target.value)}
                          className="h-12 flex-1 rounded-[1.1rem] border-white/10 bg-[#1f2623] px-5 text-[0.98rem] text-zinc-100 placeholder:text-zinc-500 focus-visible:border-[#b9f075]/35 focus-visible:ring-[#b9f075]/15"
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
                        <Button
                          size="icon-lg"
                          variant="outline"
                          className="size-12 shrink-0 rounded-[1rem] border-white/10 bg-[#1f2623] text-zinc-100 hover:bg-[#252d29]"
                          onClick={() => void handleSendCodexTask()}
                          disabled={activeTurnStatus === "running" && !activeTurnId}
                          title="Send Codex Task"
                        >
                          <Send className="size-4.5" />
                        </Button>
                      </div>

                      <div className="min-h-0 flex-1">
                        <CodexConversationPanel messages={codexMessages} />
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

          <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
            <EventPanel events={agentEvents} />
            <RealtimeLogPanel entries={realtimeLogs} />
            <JsonRpcLogPanel entries={log} />
          </div>
        </div>
      </div>
    </div>
  );
}
