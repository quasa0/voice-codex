import { useEffect, useRef, useState } from "react";
import { Activity, Cable, Mic, MicOff, PhoneOff, Play, Radio, Send, SkipForward, TerminalSquare, WandSparkles } from "lucide-react";
import { useCodexWebSocket } from "./useCodexWebSocket";
import { useOpenAIRealtime } from "./useOpenAIRealtime";
import type { OpenAIRealtimeStatus } from "./useOpenAIRealtime";
import type { LogEntry, AgentEvent, ModelInfo, CodexMessage, CodexSegment, CodexSegmentState } from "./types";
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

function getCurrentSegment(segments: CodexSegment[]) {
  const running = [...segments]
    .reverse()
    .find((segment) => segment.codexState === "running" || segment.codexState === "waiting_for_user");
  if (running) return running;
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

function getSegmentWorkingLabel(segment: CodexSegment | null) {
  if (!segment) return null;
  if (segment.codexState === "waiting_for_user") return "waiting for input...";
  if (segment.codexState !== "running") return null;

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
  if (!segment) return null;
  if (segment.codexState === "waiting_for_user") return "needs input";
  if (segment.codexState === "running") {
    if (segment.mode === "interrupt") return "switching";
    if (segment.mode === "steer") return "adjusting";
    return "working";
  }
  return "update";
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
    return fraction ? `${base}.${fraction[0]}` : base;
  }

  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return timestamp;
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 1,
    hour12: false,
  }).format(date);
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
                    <TimestampLabel timestamp={message.timestamp} className="absolute right-0" />
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
          {workingLabel ? (
            <div className="py-1.5">
              <div
                className={`relative -mr-3 flex min-h-6 w-[calc(100%+0.75rem)] items-center gap-3 overflow-hidden rounded-full border border-[#b9f075]/10 bg-[#b9f075]/[0.04] px-3 py-1.5 text-[10px] uppercase tracking-[0.18em] text-zinc-500 ${
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
                  className={`relative size-1.5 shrink-0 rounded-full bg-[#b9f075] shadow-[0_0_8px_rgba(185,240,117,0.4)] ${
                    animateWorkingRow ? "codex-working-dot" : ""
                  }`}
                />
                <span className="min-w-0 flex-1 truncate text-zinc-300">{workingLabel}</span>
                {activeSegment ? <TimestampLabel timestamp={activeSegment.updatedAt} className="shrink-0" /> : null}
              </div>
            </div>
          ) : null}
        </div>
      </ScrollArea>
    </div>
  );
}

function RealtimeConversationPanel({ messages }: { messages: RealtimeMessage[] }) {
  return (
    <div className="flex h-full min-h-0 flex-col rounded-[1.55rem] border border-white/8 bg-[#171d1b] px-4 py-4">
      <ScrollArea className="min-h-0 flex-1 pr-3">
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
                      className={`flex items-center gap-2 text-[11px] text-zinc-500 ${
                        message.role === "user" ? "justify-end" : "justify-start"
                      }`}
                    >
                      {messagePhaseLabel(message) ? (
                        <span className={message.status === "streaming" ? "text-[#b9f075]" : "text-zinc-500"}>
                          {messagePhaseLabel(message)}
                        </span>
                      ) : null}
                      {message.role === "user" ? (
                        <span className="rounded-full border border-white/8 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.14em] text-zinc-400">
                          {message.source}
                        </span>
                      ) : null}
                      <TimestampLabel timestamp={message.timestamp} />
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
    segments,
    activeTurnStatus,
    activeTurnId,
    startTurn,
    steerTurn,
    interruptTurn,
    beginSegment,
    setSegmentRelayState,
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
  const queuedInterruptReplacementRef = useRef<{ request: string; segmentId: string } | null>(null);
  const pendingCodexNarrationRef = useRef<{ request: string; segmentId: string } | null>(null);
  const codexBootstrapAttemptedRef = useRef(false);
  const realtimeBootstrapAttemptedRef = useRef(false);
  const [threadError, setThreadError] = useState<string | null>(null);
  const currentSegment = getCurrentSegment(segments);
  const currentCodexState: CodexSegmentState = currentSegment?.codexState ?? "idle";
  const currentCodexStatus = summarizeSegmentStatus(currentSegment, agentEvents);

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
        routed = await routeIntent(latestFinalUserMessage.text, currentCodexState === "running" || currentCodexState === "waiting_for_user");
        routeCacheRef.current.set(latestFinalUserMessage.id, routed);
      }

      if (routed.action === "chat_only") {
        if (routed.chat_mode === "relay_codex_status") {
          if (currentSegment && currentSegment.codexState === "running") {
            setSegmentRelayState(currentSegment.id, "progress_spoken");
          }
          sendRealtimeText(
            `Summarize current Codex segment for the user in one or two short sentences. Explain what Codex is doing now or what just happened, based only on the structured segment state below. Mention the most relevant files or steps if present. Do not repeat the user's wording. Do not invent details.\n\nCurrent Codex status:\n${currentCodexStatus}\n\nCurrent segment:\n${JSON.stringify(buildSegmentSnapshot(currentSegment), null, 2)}`,
            { requestResponse: true, visible: false },
          );
          return;
        }

        if (routed.chat_mode === "relay_latest_codex") {
          const completedSegment = [...segments]
            .reverse()
            .find((segment) => segment.finalOutcome || segment.blockingQuestion);
          if (completedSegment) {
            sendRealtimeText(
              `Codex segment result available. Relay the exact substance to the user with no invention. Be terse.\n\nUser asked: ${latestFinalUserMessage.text}\n\nSegment:\n${JSON.stringify(buildSegmentSnapshot(completedSegment), null, 2)}`,
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
        const segmentId = beginSegment("interrupt", latestFinalUserMessage.text);
        queuedInterruptReplacementRef.current = { request: latestFinalUserMessage.text, segmentId };
        pendingCodexNarrationRef.current = { request: latestFinalUserMessage.text, segmentId };
        await interruptTurn(activeThread.id);
        addRealtimeSystemMessage("interrupt", "interrupt");
        return;
      }

      if (routed.action === "codex_steer" && activeTurnStatus === "running" && activeTurnId) {
        const segmentId = beginSegment("steer", latestFinalUserMessage.text);
        pendingCodexNarrationRef.current = { request: latestFinalUserMessage.text, segmentId };
        await steerTurn(activeThread.id, latestFinalUserMessage.text, segmentId);
        addRealtimeSystemMessage("steer", "steer");
        return;
      }

      if (activeTurnStatus === "idle") {
        const segmentId = beginSegment("start", latestFinalUserMessage.text);
        pendingCodexNarrationRef.current = { request: latestFinalUserMessage.text, segmentId };
        await startTurn(activeThread.id, latestFinalUserMessage.text, segmentId);
        addRealtimeSystemMessage("new turn", "start");
      }
    };

    void dispatch().catch((error) => {
      setThreadError((error as Error).message);
    });
  }, [
    activeTurnId,
    activeTurnStatus,
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
  ]);

  useEffect(() => {
    if (!currentSegment) return;
    if (currentSegment.codexState !== "waiting_for_user") return;
    if (!currentSegment.blockingQuestion) return;
    if (currentSegment.relayState === "clarification_spoken" || currentSegment.relayState === "completion_spoken") return;

    if (pendingCodexNarrationRef.current?.segmentId === currentSegment.id) {
      pendingCodexNarrationRef.current = null;
    }

    try {
      sendRealtimeText(
        `Codex needs user input. Relay this briefly and clearly as a short spoken question. Do not add anything. Do not summarize unrelated work.\n\nCodex segment:\n${JSON.stringify(buildSegmentSnapshot(currentSegment), null, 2)}`,
        { requestResponse: true, visible: false },
      );
      setSegmentRelayState(currentSegment.id, "clarification_spoken");
    } catch (error) {
      console.error(error);
    }
  }, [currentSegment, sendRealtimeText, setSegmentRelayState]);

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

    const pending = pendingCodexNarrationRef.current;
    const targetSegment = segments.find((segment) => segment.id === pending.segmentId);
    if (!targetSegment) return;
    if (targetSegment.codexState === "running") return;
    if (targetSegment.codexState === "waiting_for_user") return;
    if (targetSegment.relayState === "completion_spoken") return;

    pendingCodexNarrationRef.current = null;

    try {
      sendRealtimeText(
        `Codex finished a segment. Give the user a very short spoken summary of what changed or what Codex accomplished. Use only the structured segment summary below. Do not read raw command output. Do not repeat the user's wording. Keep it to one or two short sentences. End with one very short follow-up question, for example "Want tweaks?" No invention.\n\nOriginal user request:\n${pending.request}\n\nCodex segment summary:\n${JSON.stringify(buildSegmentSnapshot(targetSegment), null, 2)}\n\nCondensed status:\n${summarizeSegmentStatus(targetSegment, agentEvents)}`,
        { requestResponse: true, visible: false },
      );
      setSegmentRelayState(targetSegment.id, "completion_spoken");
    } catch (error) {
      console.error(error);
    }
  }, [agentEvents, segments, sendRealtimeText, setSegmentRelayState]);

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
      <style>{`
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
      `}</style>
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
                <RealtimeStatusBadge isMuted={isMicMuted} realtimeStatus={realtimeStatus} />
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
                      className="h-8 rounded-full border border-red-500/22 bg-[#5a2e28] px-3 text-[13px] font-medium text-red-100 hover:bg-[#6a342d]"
                      onClick={() => disconnectRealtime()}
                      title="End call"
                    >
                      <PhoneOff className="size-4" />
                      End call
                    </Button>
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
              title="Codex App Server"
              description="Local Codex agent."
              icon={<Cable className="size-4" />}
              headerRight={<CodexStatusBadge codexState={currentCodexState} />}
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
