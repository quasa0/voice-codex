import { useCallback, useEffect, useRef, useState } from "react";

export type OpenAIRealtimeStatus = "idle" | "requesting-mic" | "connecting" | "active" | "error";

export interface OpenAIRealtimeLogEntry {
  id: number;
  direction: "client" | "server" | "meta";
  timestamp: string;
  label: string;
  body: string;
}

export interface OpenAIRealtimeMessage {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  status: "capturing" | "partial" | "streaming" | "final";
  source: "voice" | "text" | "voice-pending";
  timestamp: string;
  eventKind?: "start" | "steer" | "interrupt" | "interrupted" | "refreshed";
}

interface ConnectOptions {
  model: string;
  voice: string;
  instructions?: string;
  preserveHistory?: boolean;
}

interface SendTextOptions {
  requestResponse?: boolean;
  visible?: boolean;
}

let nextRealtimeLogId = 1;

function now() {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 2,
    hour12: false,
  }).format(new Date());
}

function summarizeEvent(event: unknown) {
  const e = event as Record<string, unknown>;
  return String(e?.type ?? "event");
}

const IDE_FOCUS_FILE_TOOL = {
  type: "function",
  name: "focus_file_in_ide",
  description:
    "Focuses or opens a file in the active JetBrains IDE project. Use this when the user asks to show, open, reveal, or focus a file.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "File path to focus. Prefer a project-relative path like src/App.tsx when possible, but absolute paths also work.",
      },
    },
    required: ["path"],
    additionalProperties: false,
  },
} as const;

interface UseOpenAIRealtimeOptions {
  initialMessages?: OpenAIRealtimeMessage[];
  initialLogs?: OpenAIRealtimeLogEntry[];
}

export function useOpenAIRealtime(options: UseOpenAIRealtimeOptions = {}) {
  const [status, setStatus] = useState<OpenAIRealtimeStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [logs, setLogs] = useState<OpenAIRealtimeLogEntry[]>(() => options.initialLogs ?? []);
  const [messages, setMessages] = useState<OpenAIRealtimeMessage[]>(() => options.initialMessages ?? []);
  const [isMicMuted, setIsMicMuted] = useState(true);
  const [connectedAt, setConnectedAt] = useState<number | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [isAssistantSpeaking, setIsAssistantSpeaking] = useState(false);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const pendingTextResponseRef = useRef<string | null>(null);
  const pendingHiddenResponseSeqRef = useRef<number | null>(null);
  const hiddenResponseSeqRef = useRef(0);
  const invalidatedHiddenResponseSeqRef = useRef(0);
  const assistantHiddenResponseSeqByItemRef = useRef<Map<string, number>>(new Map());
  const isMicMutedRef = useRef(true);
  const assistantSpeakingTimeoutRef = useRef<number | null>(null);
  const isAssistantSpeakingRef = useRef(false);
  const pendingFunctionCallArgsRef = useRef<Map<string, string>>(new Map());

  const clearAssistantSpeakingTimeout = useCallback(() => {
    if (assistantSpeakingTimeoutRef.current !== null) {
      window.clearTimeout(assistantSpeakingTimeoutRef.current);
      assistantSpeakingTimeoutRef.current = null;
    }
  }, []);

  const setAssistantSpeakingWithGrace = useCallback((speaking: boolean, delayMs = 0) => {
    clearAssistantSpeakingTimeout();

    if (speaking || delayMs <= 0) {
      isAssistantSpeakingRef.current = speaking;
      setIsAssistantSpeaking(speaking);
      return;
    }

    assistantSpeakingTimeoutRef.current = window.setTimeout(() => {
      isAssistantSpeakingRef.current = false;
      setIsAssistantSpeaking(false);
      assistantSpeakingTimeoutRef.current = null;
    }, delayMs);
  }, [clearAssistantSpeakingTimeout]);

  const upsertUserVoiceMessage = useCallback((id: string, text: string, status: "capturing" | "partial" | "final", source: "voice" | "voice-pending") => {
    setMessages((prev) => {
      const existing = prev.find((message) => message.id === id);
      if (existing) {
        return prev.map((message) =>
          message.id === id
            ? {
                ...message,
                text: text || message.text,
                status,
                source,
              }
            : message,
        );
      }

      return [
        ...prev,
        {
          id,
          role: "user",
          text,
          status,
          source,
          timestamp: now(),
        },
      ];
    });
  }, []);

  const removePendingVoiceMessage = useCallback((id: string) => {
    setMessages((prev) => prev.filter((message) => !(message.id === id && message.source === "voice-pending")));
  }, []);

  const finalizeStreamingAssistantMessages = useCallback(() => {
    setMessages((prev) =>
      prev.map((message) =>
        message.role === "assistant" && message.status === "streaming" && message.text.trim()
          ? { ...message, status: "final" }
          : message,
      ),
    );
  }, []);

  const addLog = useCallback((direction: OpenAIRealtimeLogEntry["direction"], label: string, body: string) => {
    setLogs((prev) => [
      ...prev,
      {
        id: nextRealtimeLogId++,
        direction,
        timestamp: now(),
        label,
        body,
      },
    ]);
  }, []);

  const sendClientEvent = useCallback((label: string, payload: Record<string, unknown>) => {
    const dc = dcRef.current;
    if (!dc || dc.readyState !== "open") {
      throw new Error("OpenAI Realtime data channel is not open");
    }

    dc.send(JSON.stringify(payload));
    addLog("client", label, JSON.stringify(payload, null, 2));
  }, [addLog]);

  const focusFileInIde = useCallback((path: string) => {
    const normalizedPath = path.trim();
    if (!normalizedPath) {
      return {
        ok: false,
        message: "Missing file path.",
      };
    }

    if (!window.IDEBridge?.openFile) {
      return {
        ok: false,
        message: "IDE bridge unavailable.",
      };
    }

    window.IDEBridge.openFile(normalizedPath);
    return {
      ok: true,
      message: `Focused ${normalizedPath}.`,
    };
  }, []);

  const submitToolResult = useCallback((callId: string, output: unknown) => {
    sendClientEvent("conversation.item.create", {
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify(output),
      },
    });
    sendClientEvent("response.create", { type: "response.create" });
  }, [sendClientEvent]);

  const addSystemMessage = useCallback((text: string, eventKind?: OpenAIRealtimeMessage["eventKind"]) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setMessages((prev) => [
      ...prev,
      {
        id: `system-${crypto.randomUUID()}`,
        role: "system",
        text: trimmed,
        status: "final",
        source: "text",
        timestamp: now(),
        eventKind,
      },
    ]);
  }, []);

  const addAssistantInterruptedMessage = useCallback(() => {
    addSystemMessage("interrupted", "interrupted");
  }, [addSystemMessage]);

  const disconnect = useCallback((nextStatus: OpenAIRealtimeStatus = "idle") => {
    dcRef.current?.close();
    dcRef.current = null;

    pcRef.current?.close();
    pcRef.current = null;

    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    localStreamRef.current = null;

    if (audioRef.current) {
      audioRef.current.srcObject = null;
    }

    setIsMicMuted(true);
    isMicMutedRef.current = true;
    setConnectedAt(null);
    setElapsedSeconds(0);
    clearAssistantSpeakingTimeout();
    isAssistantSpeakingRef.current = false;
    setIsAssistantSpeaking(false);

    setStatus(nextStatus);
  }, [clearAssistantSpeakingTimeout]);

  const requestResponse = useCallback(() => {
    sendClientEvent("response.create", { type: "response.create" });
  }, [sendClientEvent]);

  const cancelAssistantResponse = useCallback(() => {
    finalizeStreamingAssistantMessages();
    sendClientEvent("response.cancel", { type: "response.cancel" });
    sendClientEvent("output_audio_buffer.clear", { type: "output_audio_buffer.clear" });

    clearAssistantSpeakingTimeout();
    setIsAssistantSpeaking(false);
  }, [clearAssistantSpeakingTimeout, finalizeStreamingAssistantMessages, sendClientEvent]);

  const connect = useCallback(
    async ({ model, voice, instructions, preserveHistory = false }: ConnectOptions) => {
      disconnect();
      setError(null);
      setLastError(null);
      if (!preserveHistory) {
        setLogs([]);
        setMessages([]);
      }
      setStatus("requesting-mic");
      pendingHiddenResponseSeqRef.current = null;
      hiddenResponseSeqRef.current = 0;
      invalidatedHiddenResponseSeqRef.current = 0;
      assistantHiddenResponseSeqByItemRef.current.clear();

      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      } catch (e) {
        setError(`Mic permission denied: ${(e as Error).message}`);
        setStatus("error");
        return;
      }

      stream.getAudioTracks().forEach((track) => {
        track.enabled = false;
      });
      localStreamRef.current = stream;
      setIsMicMuted(true);
      isMicMutedRef.current = true;
      addLog("meta", "mic-muted", "Local microphone track disabled by default");
      setStatus("connecting");

      const pc = new RTCPeerConnection();
      pcRef.current = pc;

      const audio = audioRef.current ?? new Audio();
      audio.autoplay = true;
      audioRef.current = audio;

      pc.ontrack = (event) => {
        audio.srcObject = event.streams[0];
        void audio.play().catch(() => {});
      };

      stream.getTracks().forEach((track) => pc.addTrack(track, stream));

      const dc = pc.createDataChannel("oai-events");
      dcRef.current = dc;

      dc.addEventListener("open", () => {
        addLog("meta", "data-channel", "OpenAI Realtime data channel opened");
        sendClientEvent("session.update", {
          type: "session.update",
          session: {
            tools: [IDE_FOCUS_FILE_TOOL],
            tool_choice: "auto",
          },
        });
        setConnectedAt(Date.now());
        setElapsedSeconds(0);
        setStatus("active");
      });

      dc.addEventListener("close", () => {
        addLog("meta", "data-channel", "OpenAI Realtime data channel closed");
        if (dcRef.current === dc) {
          setStatus("idle");
        }
      });

      dc.addEventListener("message", (event) => {
        try {
          const parsed = JSON.parse(event.data) as Record<string, unknown>;
          addLog("server", summarizeEvent(parsed), event.data);

          const type = String(parsed.type ?? "");

          if (type === "input_audio_buffer.committed") {
            const itemId = String(parsed.item_id ?? "");
            if (isAssistantSpeakingRef.current) {
              addAssistantInterruptedMessage();
            }
            if (itemId && !isMicMutedRef.current) {
              upsertUserVoiceMessage(itemId, "Listening...", "capturing", "voice-pending");
            }
          }

          if (type === "conversation.item.input_audio_transcription.delta") {
            const itemId = String(parsed.item_id ?? "");
            const delta = String(parsed.delta ?? "");
            if (itemId && delta && !isMicMutedRef.current) {
              setMessages((prev) => {
                const existing = prev.find((message) => message.id === itemId);
                if (existing) {
                  const baseText = existing.text === "Listening..." || existing.text === "(voice captured)" ? "" : existing.text;
                  return prev.map((message) =>
                    message.id === itemId
                      ? { ...message, text: `${baseText}${delta}`, status: "partial", source: "voice" }
                      : message,
                  );
                }
                return [
                  ...prev,
                  {
                    id: itemId,
                    role: "user",
                    text: delta,
                    status: "partial",
                    source: "voice",
                    timestamp: now(),
                  },
                ];
              });
            }
          }

          if (type === "conversation.item.input_audio_transcription.completed") {
            const itemId = String(parsed.item_id ?? "");
            const transcript = String(parsed.transcript ?? "").trim();
            if (itemId && transcript && !isMicMutedRef.current) {
              upsertUserVoiceMessage(itemId, transcript, "final", "voice");
            }
          }

          if (type === "conversation.item.done") {
            const item = parsed.item as Record<string, unknown> | undefined;
            const itemId = String(item?.id ?? "");
            const role = String(item?.role ?? "");
            if (itemId && role === "user") {
              const content = Array.isArray(item?.content) ? (item?.content as Array<Record<string, unknown>>) : [];
              const transcript = content
                .map((part) => part.transcript)
                .find((value) => typeof value === "string" && value.trim().length > 0);

              if (!isMicMutedRef.current && typeof transcript === "string" && transcript.trim()) {
                upsertUserVoiceMessage(itemId, transcript.trim(), "final", "voice");
              } else {
                removePendingVoiceMessage(itemId);
              }
            }
          }

          if (type === "response.output_audio_transcript.delta") {
            const itemId = String(parsed.item_id ?? "");
            const delta = String(parsed.delta ?? "");
            if (itemId && delta) {
              const existingHiddenSeq = assistantHiddenResponseSeqByItemRef.current.get(itemId);
              const hiddenSeq = existingHiddenSeq ?? pendingHiddenResponseSeqRef.current;
              if (hiddenSeq !== null && hiddenSeq <= invalidatedHiddenResponseSeqRef.current) {
                return;
              }
              if (hiddenSeq !== null && existingHiddenSeq === undefined) {
                assistantHiddenResponseSeqByItemRef.current.set(itemId, hiddenSeq);
              }
              setMessages((prev) => {
                const existing = prev.find((message) => message.id === itemId);
                if (existing) {
                  return prev.map((message) =>
                    message.id === itemId ? { ...message, text: `${message.text}${delta}`, status: "streaming" } : message,
                  );
                }
                return [
                  ...prev,
                  {
                    id: itemId,
                    role: "assistant",
                    text: delta,
                    status: "streaming",
                    source: pendingTextResponseRef.current ? "text" : "voice",
                    timestamp: now(),
                  },
                ];
              });
            }
          }

          if (type === "response.output_audio_transcript.done") {
            const itemId = String(parsed.item_id ?? "");
            const transcript = String(parsed.transcript ?? "");
            if (itemId) {
              const hiddenSeq = assistantHiddenResponseSeqByItemRef.current.get(itemId);
              if (hiddenSeq !== undefined && hiddenSeq <= invalidatedHiddenResponseSeqRef.current) {
                setMessages((prev) =>
                  prev.map((message) =>
                    message.id === itemId && message.text.trim()
                      ? { ...message, status: "final" }
                      : message,
                  ),
                );
                assistantHiddenResponseSeqByItemRef.current.delete(itemId);
                pendingTextResponseRef.current = null;
                return;
              }
              setMessages((prev) =>
                prev.map((message) =>
                  message.id === itemId
                    ? { ...message, text: transcript || message.text, status: "final" }
                    : message,
                ),
              );
              assistantHiddenResponseSeqByItemRef.current.delete(itemId);
              pendingTextResponseRef.current = null;
              pendingHiddenResponseSeqRef.current = null;
            }
          }

          if (type === "response.function_call_arguments.delta") {
            const itemId = String(parsed.item_id ?? "");
            const delta = String(parsed.delta ?? "");
            if (itemId && delta) {
              const existing = pendingFunctionCallArgsRef.current.get(itemId) ?? "";
              pendingFunctionCallArgsRef.current.set(itemId, `${existing}${delta}`);
            }
          }

          if (type === "response.function_call_arguments.done") {
            const itemId = String(parsed.item_id ?? "");
            const callId = String(parsed.call_id ?? "");
            const name = String(parsed.name ?? "");
            const completedArguments =
              String(parsed.arguments ?? "") || pendingFunctionCallArgsRef.current.get(itemId) || "";
            if (itemId) {
              pendingFunctionCallArgsRef.current.delete(itemId);
            }

            let parsedArguments: Record<string, unknown> = {};
            try {
              parsedArguments = completedArguments ? JSON.parse(completedArguments) as Record<string, unknown> : {};
            } catch {
              parsedArguments = {};
            }

            if (name === "focus_file_in_ide" && callId) {
              const path = typeof parsedArguments.path === "string" ? parsedArguments.path : "";
              const result = focusFileInIde(path);
              submitToolResult(callId, result);
            }
          }

          if (type === "output_audio_buffer.started") {
            setAssistantSpeakingWithGrace(true);
          }

          if (type === "response.output_audio.done" || type === "response.done") {
            setAssistantSpeakingWithGrace(false, 1500);
          }

        } catch {
          addLog("server", "event", String(event.data));
        }
      });

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      addLog("client", "webrtc-offer", "Created local SDP offer");

      let answerSdp: string;
      try {
        const response = await fetch("/__openai_realtime/session", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            sdp: offer.sdp,
            model,
            voice,
            instructions,
          }),
        });

        answerSdp = await response.text();
        if (!response.ok) {
          throw new Error(answerSdp || `Realtime session request failed with ${response.status}`);
        }
      } catch (e) {
        const message = `Failed to start OpenAI Realtime session: ${(e as Error).message}`;
        setError(message);
        setLastError(message);
        disconnect("error");
        return;
      }

      await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
      addLog("meta", "webrtc-answer", "Accepted OpenAI Realtime SDP answer");
    },
    [addAssistantInterruptedMessage, addLog, disconnect, focusFileInIde, removePendingVoiceMessage, sendClientEvent, setAssistantSpeakingWithGrace, submitToolResult, upsertUserVoiceMessage],
  );

  const sendText = useCallback(
    (text: string, options: SendTextOptions = {}) => {
      const { requestResponse: shouldRequestResponse = true, visible = true } = options;
      const isHiddenRelay = shouldRequestResponse && !visible;

      // Hard-interrupt any previous assistant reply before queuing the next user turn.
      try {
        if (visible && isAssistantSpeakingRef.current) {
          addAssistantInterruptedMessage();
        }
        cancelAssistantResponse();
      } catch {
        // If cancel cannot be sent, continue with the new user message.
      }

      if (visible) {
        invalidatedHiddenResponseSeqRef.current = hiddenResponseSeqRef.current;
        pendingHiddenResponseSeqRef.current = null;
      } else if (isHiddenRelay) {
        hiddenResponseSeqRef.current += 1;
        pendingHiddenResponseSeqRef.current = hiddenResponseSeqRef.current;
      }

      const userEvent = {
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text }],
        },
      };

      sendClientEvent("conversation.item.create", userEvent);
      if (shouldRequestResponse) {
        sendClientEvent("response.create", { type: "response.create" });
      }
      pendingTextResponseRef.current = text;
      if (visible) {
        setMessages((prev) => [
          ...prev,
          {
            id: `text-${crypto.randomUUID()}`,
            role: "user",
            text,
            status: "final",
            source: "text",
            timestamp: now(),
          },
        ]);
      }
    },
    [addAssistantInterruptedMessage, cancelAssistantResponse, sendClientEvent],
  );

  const setMicMuted = useCallback((muted: boolean) => {
    const stream = localStreamRef.current;
    if (!stream) return;

    stream.getAudioTracks().forEach((track) => {
      track.enabled = !muted;
    });
    setIsMicMuted(muted);
    isMicMutedRef.current = muted;
    addLog("meta", muted ? "mic-muted" : "mic-unmuted", muted ? "Local microphone track disabled" : "Local microphone track enabled");
  }, [addLog]);

  const toggleMicMuted = useCallback(() => {
    setMicMuted(!isMicMuted);
  }, [isMicMuted, setMicMuted]);

  const skipAssistant = useCallback(() => {
    if (isAssistantSpeakingRef.current) {
      addAssistantInterruptedMessage();
    }
    cancelAssistantResponse();
  }, [addAssistantInterruptedMessage, cancelAssistantResponse]);

  useEffect(() => {
    if (!connectedAt) return;
    const interval = window.setInterval(() => {
      setElapsedSeconds(Math.max(0, Math.floor((Date.now() - connectedAt) / 1000)));
    }, 1000);
    return () => window.clearInterval(interval);
  }, [connectedAt]);

  useEffect(() => () => {
    clearAssistantSpeakingTimeout();
    disconnect();
  }, [clearAssistantSpeakingTimeout, disconnect]);

  return {
    status,
    error,
    lastError,
    logs,
    messages,
    isMicMuted,
    connectedAt,
    elapsedSeconds,
    connect,
    disconnect,
    requestResponse,
    sendText,
    setMicMuted,
    toggleMicMuted,
    isAssistantSpeaking,
    skipAssistant,
    cancelAssistantResponse,
    addSystemMessage,
  };
}
