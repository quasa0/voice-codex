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
  role: "user" | "assistant";
  text: string;
  status: "capturing" | "partial" | "streaming" | "final";
  source: "voice" | "text" | "voice-pending";
  timestamp: string;
}

interface ConnectOptions {
  model: string;
  voice: string;
  instructions?: string;
}

interface SendTextOptions {
  requestResponse?: boolean;
  visible?: boolean;
}

let nextRealtimeLogId = 1;

function now() {
  return new Date().toISOString().slice(11, 23);
}

function summarizeEvent(event: unknown) {
  const e = event as Record<string, unknown>;
  return String(e?.type ?? "event");
}

export function useOpenAIRealtime() {
  const [status, setStatus] = useState<OpenAIRealtimeStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [logs, setLogs] = useState<OpenAIRealtimeLogEntry[]>([]);
  const [messages, setMessages] = useState<OpenAIRealtimeMessage[]>([]);
  const [isMicMuted, setIsMicMuted] = useState(true);
  const [connectedAt, setConnectedAt] = useState<number | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [isAssistantSpeaking, setIsAssistantSpeaking] = useState(false);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const pendingTextResponseRef = useRef<string | null>(null);
  const isMicMutedRef = useRef(true);

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
    setIsAssistantSpeaking(false);

    setStatus(nextStatus);
  }, []);

  const requestResponse = useCallback(() => {
    const dc = dcRef.current;
    if (!dc || dc.readyState !== "open") {
      throw new Error("OpenAI Realtime data channel is not open");
    }

    const responseEvent = { type: "response.create" };
    dc.send(JSON.stringify(responseEvent));
    addLog("client", "response.create", JSON.stringify(responseEvent, null, 2));
  }, [addLog]);

  const connect = useCallback(
    async ({ model, voice, instructions }: ConnectOptions) => {
      disconnect();
      setError(null);
      setLastError(null);
      setLogs([]);
      setMessages([]);
      setStatus("requesting-mic");

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
              setMessages((prev) =>
                prev.map((message) =>
                  message.id === itemId
                    ? { ...message, text: transcript || message.text, status: "final" }
                    : message,
                ),
              );
              pendingTextResponseRef.current = null;
            }
          }

          if (type === "output_audio_buffer.started") {
            setIsAssistantSpeaking(true);
          }

          if (type === "output_audio_buffer.stopped" || type === "response.output_audio.done" || type === "response.done") {
            setIsAssistantSpeaking(false);
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
    [addLog, disconnect, removePendingVoiceMessage, upsertUserVoiceMessage],
  );

  const sendText = useCallback(
    (text: string, options: SendTextOptions = {}) => {
      const dc = dcRef.current;
      if (!dc || dc.readyState !== "open") {
        throw new Error("OpenAI Realtime data channel is not open");
      }

      const { requestResponse: shouldRequestResponse = true, visible = true } = options;
      const userEvent = {
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text }],
        },
      };

      dc.send(JSON.stringify(userEvent));
      addLog("client", "conversation.item.create", JSON.stringify(userEvent, null, 2));
      if (shouldRequestResponse) {
        const responseEvent = { type: "response.create" };
        dc.send(JSON.stringify(responseEvent));
        addLog("client", "response.create", JSON.stringify(responseEvent, null, 2));
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
    [addLog],
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
    const dc = dcRef.current;
    if (!dc || dc.readyState !== "open") {
      throw new Error("OpenAI Realtime data channel is not open");
    }

    const cancelEvent = { type: "response.cancel" };
    dc.send(JSON.stringify(cancelEvent));
    addLog("client", "response.cancel", JSON.stringify(cancelEvent, null, 2));
    setIsAssistantSpeaking(false);
  }, [addLog]);

  useEffect(() => {
    if (!connectedAt) return;
    const interval = window.setInterval(() => {
      setElapsedSeconds(Math.max(0, Math.floor((Date.now() - connectedAt) / 1000)));
    }, 1000);
    return () => window.clearInterval(interval);
  }, [connectedAt]);

  useEffect(() => () => disconnect(), [disconnect]);

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
  };
}
