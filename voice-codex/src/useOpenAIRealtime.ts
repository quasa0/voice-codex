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
  status: "streaming" | "complete";
  source: "voice" | "text" | "voice-pending";
  timestamp: string;
}

interface ConnectOptions {
  model: string;
  voice: string;
  instructions?: string;
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
  const [logs, setLogs] = useState<OpenAIRealtimeLogEntry[]>([]);
  const [messages, setMessages] = useState<OpenAIRealtimeMessage[]>([]);
  const [isMicMuted, setIsMicMuted] = useState(false);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const pendingTextResponseRef = useRef<string | null>(null);
  const respondedVoiceItemIdsRef = useRef<Set<string>>(new Set());

  const upsertUserVoiceMessage = useCallback((id: string, text: string, status: "streaming" | "complete", source: "voice" | "voice-pending") => {
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

    respondedVoiceItemIdsRef.current.clear();
    setIsMicMuted(false);

    setStatus(nextStatus);
  }, []);

  const connect = useCallback(
    async ({ model, voice, instructions }: ConnectOptions) => {
      disconnect();
      setError(null);
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

      localStreamRef.current = stream;
      setIsMicMuted(false);
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
            if (itemId) {
              upsertUserVoiceMessage(itemId, "Listening...", "streaming", "voice-pending");
            }
          }

          if (type === "conversation.item.input_audio_transcription.delta") {
            const itemId = String(parsed.item_id ?? "");
            const delta = String(parsed.delta ?? "");
            if (itemId && delta) {
              setMessages((prev) => {
                const existing = prev.find((message) => message.id === itemId);
                if (existing) {
                  const baseText = existing.text === "Listening..." || existing.text === "(voice captured)" ? "" : existing.text;
                  return prev.map((message) =>
                    message.id === itemId
                      ? { ...message, text: `${baseText}${delta}`, status: "streaming", source: "voice" }
                      : message,
                  );
                }
                return [
                  ...prev,
                  {
                    id: itemId,
                    role: "user",
                    text: delta,
                    status: "streaming",
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
            if (itemId && transcript) {
              upsertUserVoiceMessage(itemId, transcript, "complete", "voice");
              if (!respondedVoiceItemIdsRef.current.has(itemId) && dc.readyState === "open") {
                const responseEvent = { type: "response.create" };
                dc.send(JSON.stringify(responseEvent));
                addLog("client", "response.create", JSON.stringify(responseEvent, null, 2));
                respondedVoiceItemIdsRef.current.add(itemId);
              }
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

              if (typeof transcript === "string" && transcript.trim()) {
                upsertUserVoiceMessage(itemId, transcript.trim(), "complete", "voice");
                if (!respondedVoiceItemIdsRef.current.has(itemId) && dc.readyState === "open") {
                  const responseEvent = { type: "response.create" };
                  dc.send(JSON.stringify(responseEvent));
                  addLog("client", "response.create", JSON.stringify(responseEvent, null, 2));
                  respondedVoiceItemIdsRef.current.add(itemId);
                }
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
                    ? { ...message, text: transcript || message.text, status: "complete" }
                    : message,
                ),
              );
              pendingTextResponseRef.current = null;
            }
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
        setError(`Failed to start OpenAI Realtime session: ${(e as Error).message}`);
        disconnect("error");
        return;
      }

      await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
      addLog("meta", "webrtc-answer", "Accepted OpenAI Realtime SDP answer");
    },
    [addLog, disconnect, removePendingVoiceMessage, upsertUserVoiceMessage],
  );

  const sendText = useCallback(
    (text: string) => {
      const dc = dcRef.current;
      if (!dc || dc.readyState !== "open") {
        throw new Error("OpenAI Realtime data channel is not open");
      }

      const userEvent = {
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text }],
        },
      };
      const responseEvent = { type: "response.create" };

      dc.send(JSON.stringify(userEvent));
      dc.send(JSON.stringify(responseEvent));
      addLog("client", "conversation.item.create", JSON.stringify(userEvent, null, 2));
      addLog("client", "response.create", JSON.stringify(responseEvent, null, 2));
      pendingTextResponseRef.current = text;
      setMessages((prev) => [
        ...prev,
        {
          id: `text-${crypto.randomUUID()}`,
          role: "user",
          text,
          status: "complete",
          source: "text",
          timestamp: now(),
        },
      ]);
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
    addLog("meta", muted ? "mic-muted" : "mic-unmuted", muted ? "Local microphone track disabled" : "Local microphone track enabled");
  }, [addLog]);

  const toggleMicMuted = useCallback(() => {
    setMicMuted(!isMicMuted);
  }, [isMicMuted, setMicMuted]);

  useEffect(() => () => disconnect(), [disconnect]);

  return { status, error, logs, messages, isMicMuted, connect, disconnect, sendText, setMicMuted, toggleMicMuted };
}
