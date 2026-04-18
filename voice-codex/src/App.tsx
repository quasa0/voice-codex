import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity,
  Cable,
  KeyRound,
  MessageSquare,
  Mic,
  MicOff,
  Play,
  Radio,
  RefreshCw,
  Square,
  TerminalSquare,
  WandSparkles,
} from "lucide-react";
import { useCodexWebSocket } from "./useCodexWebSocket";
import { useVoiceSession } from "./useVoiceSession";
import { useOpenAIRealtime } from "./useOpenAIRealtime";
import type { LogEntry, AgentEvent, ModelInfo } from "./types";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";

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
  role: "user" | "assistant";
  text: string;
  status: "streaming" | "complete";
  source: "voice" | "text" | "voice-pending";
  timestamp: string;
};

function statusBadgeClass(status: string) {
  if (status === "connected" || status === "active" || status === "apiKey") {
    return "border-emerald-400/40 bg-emerald-500/12 text-emerald-200";
  }
  if (status === "connecting" || status === "requesting-mic") {
    return "border-amber-400/40 bg-amber-500/12 text-amber-200";
  }
  if (status === "error") {
    return "border-red-400/40 bg-red-500/12 text-red-200";
  }
  return "border-zinc-500/40 bg-zinc-500/10 text-zinc-300";
}

function statusDotClass(status: string) {
  if (status === "connected" || status === "active" || status === "apiKey") return "bg-emerald-300";
  if (status === "connecting" || status === "requesting-mic") return "bg-amber-300";
  if (status === "error") return "bg-red-300";
  return "bg-zinc-400";
}

function controlSurfaceClass() {
  return "bg-zinc-950/75 border-white/10 text-zinc-100 shadow-none";
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

function PanelShell({
  title,
  description,
  icon,
  children,
  contentClassName,
}: {
  title: string;
  description?: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
  contentClassName?: string;
}) {
  return (
    <Card className="border-white/10 bg-zinc-900/72 shadow-xl shadow-black/20 backdrop-blur-sm">
      <CardHeader className="space-y-1 pb-3">
        <div className="flex items-center gap-3">
          {icon ? (
            <div className="flex size-7 items-center justify-center rounded-md border border-white/10 bg-white/[0.04] text-zinc-100">
              {icon}
            </div>
          ) : null}
          <div>
            <CardTitle className="text-[1.05rem] font-semibold tracking-tight text-zinc-50">{title}</CardTitle>
            {description ? (
              <CardDescription className="text-sm leading-5 text-zinc-400">{description}</CardDescription>
            ) : null}
          </div>
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
        <div className="space-y-3">
          {entries.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-white/10 bg-white/[0.02] px-4 py-6 text-sm text-zinc-500">
              No JSON-RPC traffic yet.
            </div>
          ) : (
            entries.map((entry) => (
              <div
                key={entry.id}
                className="rounded-lg border border-white/10 bg-zinc-950/80 p-3 font-mono text-xs text-zinc-300"
              >
                <div className="mb-2 flex items-center gap-2 text-[11px] uppercase tracking-[0.2em] text-zinc-500">
                  <span>{entry.timestamp}</span>
                  <span className={entry.direction === "sent" ? "text-white" : "text-zinc-300"}>
                    {entry.direction === "sent" ? "sent" : "received"}
                  </span>
                </div>
                <pre className="overflow-x-auto whitespace-pre-wrap break-all text-[11px] leading-5">
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
        <div className="space-y-3">
          {entries.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-white/10 bg-white/[0.02] px-4 py-6 text-sm text-zinc-500">
              No OpenAI Realtime events yet.
            </div>
          ) : (
            entries.map((entry) => (
              <div
                key={entry.id}
                className="rounded-lg border border-white/10 bg-zinc-950/80 p-3 font-mono text-xs text-zinc-300"
              >
                <div className="mb-2 flex items-center gap-2 text-[11px] uppercase tracking-[0.2em] text-zinc-500">
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
                <pre className="overflow-x-auto whitespace-pre-wrap break-all text-[11px] leading-5">
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
        <div className="space-y-3">
          {filtered.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-white/10 bg-white/[0.02] px-4 py-6 text-sm text-zinc-500">
              No agent events yet.
            </div>
          ) : (
            filtered.map((event) => (
              <div key={event.id} className="rounded-lg border border-white/10 bg-zinc-950/80 p-3">
                <div className="mb-2 flex items-center gap-2 text-[11px] uppercase tracking-[0.2em] text-zinc-500">
                  <span>{event.timestamp}</span>
                  <span className={eventToneClass(event.method)}>{event.method}</span>
                </div>
                <p className="text-sm leading-6 text-zinc-300">{event.summary}</p>
              </div>
            ))
          )}
        </div>
      </ScrollArea>
    </PanelShell>
  );
}

function ConversationPanel({ messages }: { messages: RealtimeMessage[] }) {
  return (
    <PanelShell
      title="Realtime Conversation"
      description="Voice and text messages flowing through OpenAI Realtime."
      icon={<MessageSquare className="size-4" />}
      contentClassName="pt-0"
    >
      <ScrollArea className="h-[26rem] pr-3">
        <div className="space-y-1.5">
          {messages.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-white/10 bg-white/[0.02] px-4 py-6 text-sm text-zinc-500">
              No conversation messages yet.
            </div>
          ) : (
            messages.map((message) => (
              <div
                key={message.id}
                className={`grid gap-2 border-b border-white/6 py-2 ${
                  message.role === "assistant" ? "grid-cols-[72px_minmax(0,1fr)]" : "grid-cols-[minmax(0,1fr)_72px]"
                }`}
              >
                {message.role === "assistant" ? (
                  <>
                    <div className="pt-0.5 text-right text-[10px] uppercase tracking-[0.18em] text-zinc-500">
                      <div className="text-zinc-300">Assistant</div>
                      <div>{message.source}</div>
                    </div>
                    <div className="min-w-0">
                      <div className="mb-1 flex items-center gap-2 text-[10px] uppercase tracking-[0.16em] text-zinc-600">
                        <span>{message.status}</span>
                        <span>{message.timestamp}</span>
                      </div>
                      <div className="whitespace-pre-wrap text-[13px] leading-5 text-zinc-100">
                        {message.text || "..."}
                      </div>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="min-w-0 text-right">
                      <div className="mb-1 flex justify-end gap-2 text-[10px] uppercase tracking-[0.16em] text-zinc-600">
                        <span>{message.timestamp}</span>
                        <span>{message.status}</span>
                      </div>
                      <div className="whitespace-pre-wrap text-[13px] leading-5 text-zinc-100">
                        {message.text || "..."}
                      </div>
                    </div>
                    <div className="pt-0.5 text-left text-[10px] uppercase tracking-[0.18em] text-zinc-500">
                      <div className="text-zinc-300">User</div>
                      <div>{message.source}</div>
                    </div>
                  </>
                )}
              </div>
            ))
          )}
        </div>
      </ScrollArea>
    </PanelShell>
  );
}

function pickDefaultModel(models: ModelInfo[]) {
  const realtimeCandidate = models.find((model) => model.id.toLowerCase().includes("realtime"));
  return realtimeCandidate?.id ?? models[0]?.id ?? "codex-mini-latest";
}

function voiceStatusColor(status: string) {
  if (status === "active") return "text-white";
  if (status === "error") return "text-red-300";
  if (status === "connecting" || status === "requesting-mic") return "text-zinc-200";
  return "text-zinc-400";
}

export default function App() {
  const [wsUrl, setWsUrl] = useState("ws://localhost:3001?target=ws://127.0.0.1:3000");
  const [cwd, setCwd] = useState("/tmp");
  const [selectedModel, setSelectedModel] = useState("codex-mini-latest");
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
  const prevEventCount = useRef(0);
  const [threadError, setThreadError] = useState<string | null>(null);

  const onSdpNotification = useCallback((handler: (sdp: string) => void) => {
    sdpHandlerRef.current = handler;
    return () => {
      sdpHandlerRef.current = null;
    };
  }, []);

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
    } catch (error) {
      setAuthError((error as Error).message);
    } finally {
      setAuthBusy(false);
    }
  };

  const handleLogout = async () => {
    setAuthBusy(true);
    setAuthError(null);
    try {
      await logout();
    } catch (error) {
      setAuthError((error as Error).message);
    } finally {
      setAuthBusy(false);
    }
  };

  const handleStartThread = async () => {
    setThreadError(null);
    try {
      await startThread(cwd, selectedModel);
    } catch (error) {
      setThreadError((error as Error).message);
    }
  };

  const handleStartRealtime = async () => {
    await connectRealtime({
      model: "gpt-realtime",
      voice: "marin",
      instructions:
        "You are a helpful voice coding assistant. Speak only in English unless the user explicitly asks for another language. Keep answers concise and wait until the user finishes speaking before replying.",
    });
  };

  const handleSendRealtimeText = () => {
    const text = realtimeText.trim();
    if (!text) return;
    try {
      sendRealtimeText(text);
      setRealtimeText("");
    } catch (error) {
      console.error(error);
    }
  };

  return (
    <div className="dark min-h-screen bg-transparent text-zinc-50">
      <div className="mx-auto flex max-w-[1500px] flex-col gap-4 px-3 py-3 sm:px-5 lg:px-6">
        <Card className="overflow-hidden border-white/10 bg-zinc-900/72 shadow-xl shadow-black/20">
          <CardContent className="flex flex-col gap-4 px-4 py-4 lg:flex-row lg:items-start lg:justify-between">
            <div className="max-w-3xl space-y-3">
              <Badge variant="outline" className="border-white/12 bg-white/[0.04] text-zinc-300">
                Shack15 Hackathon Build
              </Badge>
              <div className="space-y-1.5">
                <h1 className="text-2xl font-semibold tracking-tight text-zinc-50 sm:text-3xl lg:text-[2.35rem]">
                  Voice Codex
                </h1>
                <p className="max-w-2xl text-sm leading-6 text-zinc-400">
                  A dark realtime control room for OpenAI voice sessions and local Codex threads. The voice lane is live today,
                  and the Codex lane stays intact for the next step: wiring spoken intent into local coding workflows.
                </p>
              </div>
            </div>

            <div className="grid w-full max-w-md gap-2 sm:grid-cols-3 lg:pt-1">
              <div className="rounded-lg border border-white/12 bg-white/[0.04] p-3">
                <div className="mb-2 text-[11px] uppercase tracking-[0.2em] text-zinc-300">Codex WS</div>
                <Badge className={`gap-2 ${statusBadgeClass(status)}`}>
                  <span className={`size-1.5 rounded-full ${statusDotClass(status)}`} />
                  {status}
                </Badge>
              </div>
              <div className="rounded-lg border border-white/12 bg-white/[0.04] p-3">
                <div className="mb-2 text-[11px] uppercase tracking-[0.2em] text-zinc-300">Realtime</div>
                <Badge className={`gap-2 ${statusBadgeClass(realtimeStatus)}`}>
                  <span className={`size-1.5 rounded-full ${statusDotClass(realtimeStatus)}`} />
                  {realtimeStatus}
                </Badge>
              </div>
              <div className="rounded-lg border border-white/12 bg-white/[0.04] p-3">
                <div className="mb-2 text-[11px] uppercase tracking-[0.2em] text-zinc-300">Auth</div>
                <Badge className={`gap-2 ${statusBadgeClass(account?.type ?? "unknown")}`}>
                  <span className={`size-1.5 rounded-full ${statusDotClass(account?.type ?? "unknown")}`} />
                  {account?.type ?? "unknown"}
                </Badge>
              </div>
            </div>
          </CardContent>
        </Card>

        <div className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <PanelShell
              title="OpenAI Realtime"
              description="Direct voice lane over the OpenAI Realtime API."
              icon={<WandSparkles className="size-4" />}
              contentClassName="space-y-4"
            >
              <div className="flex flex-wrap items-center gap-2">
                <Badge className={`gap-2 ${statusBadgeClass(realtimeStatus)}`}>
                  <span className={`size-1.5 rounded-full ${statusDotClass(realtimeStatus)}`} />
                  Realtime: {realtimeStatus}
                </Badge>
                <Badge variant="outline" className="border-white/15 bg-zinc-950 text-zinc-300">
                  {isMicMuted ? "Mic muted" : "Mic live"}
                </Badge>
                <Badge variant="outline" className="border-white/15 bg-zinc-950 text-zinc-300">
                  gpt-realtime
                </Badge>
                <Badge variant="outline" className="border-white/15 bg-zinc-950 text-zinc-300">
                  marin
                </Badge>
              </div>

              <div className="flex flex-wrap gap-2">
                {realtimeStatus === "active" || realtimeStatus === "connecting" || realtimeStatus === "requesting-mic" ? (
                  <>
                    <Button className="bg-zinc-100 text-zinc-950 hover:bg-white" onClick={toggleMicMuted} disabled={realtimeStatus !== "active"}>
                      {isMicMuted ? <Mic className="size-4" /> : <MicOff className="size-4" />}
                      {isMicMuted ? "Unmute Mic" : "Mute Mic"}
                    </Button>
                    <Button variant="destructive" className="border-red-500/25 bg-red-500/12 text-red-100 hover:bg-red-500/18" onClick={() => disconnectRealtime()}>
                      <Square className="size-4" />
                      Stop Realtime
                    </Button>
                  </>
                ) : (
                  <Button className="bg-zinc-100 text-zinc-950 hover:bg-white" onClick={() => void handleStartRealtime()}>
                    <Play className="size-4" />
                    Start Realtime Voice
                  </Button>
                )}
              </div>

              <div className="flex flex-col gap-3">
                <Input
                  value={realtimeText}
                  onChange={(event) => setRealtimeText(event.target.value)}
                  className={controlSurfaceClass()}
                  placeholder="Send text into the realtime session"
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      handleSendRealtimeText();
                    }
                  }}
                />
                <Button variant="outline" className="border-white/12 bg-zinc-950/55 text-zinc-100 hover:bg-zinc-900" onClick={handleSendRealtimeText} disabled={realtimeStatus !== "active"}>
                  <MessageSquare className="size-4" />
                  Send Text
                </Button>
              </div>

              {realtimeError ? (
                <div className="rounded-2xl border border-red-500/20 bg-red-950/30 px-4 py-3 text-sm text-red-200">
                  {realtimeError}
                </div>
              ) : null}
            </PanelShell>

            <PanelShell
              title="Codex App Server"
              description="Preserved local Codex control path for threads, auth, and later voice-to-code orchestration."
              icon={<Cable className="size-4" />}
              contentClassName="space-y-4"
            >
              <div className="flex flex-wrap items-center gap-2">
                <Badge className={`gap-2 ${statusBadgeClass(status)}`}>
                  <span className={`size-1.5 rounded-full ${statusDotClass(status)}`} />
                  Codex: {status}
                </Badge>
                {account?.type ? <Badge variant="outline" className="border-white/15 bg-zinc-950 text-zinc-200">Auth: {account.type}</Badge> : null}
              </div>

              <div className="flex flex-col gap-3">
                <Input
                  value={wsUrl}
                  onChange={(event) => setWsUrl(event.target.value)}
                  className={`${controlSurfaceClass()} font-mono`}
                  placeholder="ws://localhost:3001?target=ws://127.0.0.1:3000"
                />
                {status === "disconnected" || status === "error" ? (
                  <Button className="bg-zinc-100 text-zinc-950 hover:bg-white" onClick={handleConnect}>
                    <Cable className="size-4" />
                    Connect
                  </Button>
                ) : (
                  <Button variant="outline" className="border-white/12 bg-zinc-950/55 text-zinc-100 hover:bg-zinc-900" onClick={disconnect}>
                    <Square className="size-4" />
                    Disconnect
                  </Button>
                )}
              </div>

              {status === "connected" ? (
                <>
                  <Separator className="bg-white/10" />

                  <div className="space-y-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline" className="border-white/15 bg-zinc-950 text-zinc-200">
                        Auth: {account?.type ?? "unknown"}
                      </Badge>
                      {account?.email ? (
                        <Badge variant="outline" className="border-white/15 bg-zinc-950 text-zinc-300">
                          {account.email}
                        </Badge>
                      ) : null}
                      {account?.orgName ? (
                        <Badge variant="outline" className="border-white/15 bg-zinc-950 text-zinc-300">
                          {account.orgName}
                        </Badge>
                      ) : null}
                    </div>

                    <div className="grid gap-3">
                      <Input
                        type="password"
                        value={apiKey}
                        onChange={(event) => setApiKey(event.target.value)}
                        className={controlSurfaceClass()}
                        placeholder="OpenAI API key for account/login/start"
                      />
                      <div className="flex flex-wrap gap-2">
                        <Button className="bg-white text-black hover:bg-zinc-200" onClick={() => void handleApiKeyLogin()} disabled={authBusy}>
                          <KeyRound className="size-4" />
                          {authBusy ? "Working..." : "Use API Key"}
                        </Button>
                        <Button variant="outline" className="border-white/20 bg-zinc-900 text-zinc-100 hover:bg-zinc-800" onClick={() => void readAccount()}>
                          <RefreshCw className="size-4" />
                          Refresh Account
                        </Button>
                        <Button variant="destructive" onClick={() => void handleLogout()} disabled={authBusy}>
                          Logout
                        </Button>
                      </div>
                    </div>

                    <p className="text-sm leading-7 text-zinc-400">
                      This logs the current app-server session into API-key mode through{" "}
                      <code className="text-zinc-200">account/login/start</code>.
                    </p>
                  </div>

                  <Separator className="bg-white/10" />

                  {!thread ? (
                    <div className="space-y-4">
                      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
                        <Select value={selectedModel} onValueChange={setSelectedModel}>
                          <SelectTrigger className={`w-full ${controlSurfaceClass()}`}>
                            <SelectValue placeholder="Codex model" />
                          </SelectTrigger>
                          <SelectContent>
                            {(models.length === 0 ? [{ id: selectedModel }] : models).map((model) => (
                              <SelectItem key={model.id} value={model.id}>
                                {model.id}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <Button variant="outline" className="border-white/20 bg-zinc-900 text-zinc-100 hover:bg-zinc-800" onClick={() => void listModels()}>
                          <RefreshCw className="size-4" />
                          Refresh
                        </Button>
                      </div>

                      <p className="text-sm leading-7 text-zinc-400">
                        {models.some((model) => model.id.toLowerCase().includes("realtime"))
                          ? "A realtime-looking model was found. If Codex voice still fails, start a new thread with a different model."
                          : "No obvious realtime model is listed by app-server. That matches the current known limitation in the Codex lane."}
                      </p>

                      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
                        <Input
                          value={cwd}
                          onChange={(event) => setCwd(event.target.value)}
                          className={`${controlSurfaceClass()} font-mono`}
                          placeholder="Working directory"
                        />
                        <Button className="bg-white text-black hover:bg-zinc-200" onClick={handleStartThread}>
                          <Play className="size-4" />
                          Start Thread
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-4">
                      <div className="rounded-lg border border-white/10 bg-zinc-950/80 p-3">
                        <div className="mb-2 text-[11px] uppercase tracking-[0.18em] text-zinc-500">Active Thread</div>
                        <div className="break-all font-mono text-sm text-zinc-100">{thread.id}</div>
                        <div className="mt-3 flex items-center gap-2 text-sm">
                          <span className="text-zinc-500">Voice:</span>
                          <span className={voiceStatusColor(voiceStatus)}>{voiceStatus}</span>
                        </div>
                      </div>

                      <div className="flex flex-wrap gap-2">
                        {voiceStatus === "idle" || voiceStatus === "error" ? (
                          <Button className="bg-white text-black hover:bg-zinc-200" onClick={startVoice}>
                            <Mic className="size-4" />
                            Start Codex Voice
                          </Button>
                        ) : (
                          <Button variant="destructive" onClick={stopVoice}>
                            <Square className="size-4" />
                            Stop Codex Voice
                          </Button>
                        )}
                      </div>
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

              {voiceError ? (
                <div className="rounded-2xl border border-red-500/20 bg-red-950/30 px-4 py-3 text-sm text-red-200">
                  {voiceError}
                </div>
              ) : null}
            </PanelShell>
          </div>

          <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
            <ConversationPanel messages={realtimeMessages} />
            <RealtimeLogPanel entries={realtimeLogs} />
            <EventPanel events={agentEvents} />
            <JsonRpcLogPanel entries={log} />
          </div>
        </div>
      </div>
    </div>
  );
}
