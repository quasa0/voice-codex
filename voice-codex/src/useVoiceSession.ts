import { useCallback, useRef, useState } from "react";

type VoiceStatus = "idle" | "requesting-mic" | "connecting" | "active" | "error";

interface UseVoiceSessionOptions {
  send: (method: string, params?: unknown) => Promise<unknown>;
  threadId: string;
  onSdpNotification: (handler: (sdp: string) => void) => () => void;
}

export function useVoiceSession({ send, threadId, onSdpNotification }: UseVoiceSessionOptions) {
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const startVoice = useCallback(async () => {
    setError(null);
    setVoiceStatus("requesting-mic");

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch (e) {
      setError(`Mic permission denied: ${(e as Error).message}`);
      setVoiceStatus("error");
      return;
    }

    setVoiceStatus("connecting");

    const pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });
    pcRef.current = pc;

    // Add mic track
    for (const track of stream.getTracks()) {
      pc.addTrack(track, stream);
    }

    // Play back remote audio
    pc.ontrack = (ev) => {
      const audio = audioRef.current ?? new Audio();
      audioRef.current = audio;
      audio.srcObject = ev.streams[0];
      audio.autoplay = true;
      audio.play().catch(() => {});
    };

    // Subscribe to SDP answer notification before sending offer
    const unsubscribe = onSdpNotification(async (answerSdp: string) => {
      try {
        await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
        setVoiceStatus("active");
      } catch (e) {
        setError(`Failed to set remote SDP: ${(e as Error).message}`);
        setVoiceStatus("error");
      }
    });

    // Gather ICE candidates before creating offer
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    // Wait for ICE gathering to complete
    await new Promise<void>((resolve) => {
      if (pc.iceGatheringState === "complete") {
        resolve();
        return;
      }
      const check = () => {
        if (pc.iceGatheringState === "complete") {
          pc.removeEventListener("icegatheringstatechange", check);
          resolve();
        }
      };
      pc.addEventListener("icegatheringstatechange", check);
      // Timeout after 5s to avoid hanging if STUN is slow
      setTimeout(resolve, 5000);
    });

    const finalSdp = pc.localDescription?.sdp;
    if (!finalSdp) {
      setError("Failed to generate SDP offer");
      setVoiceStatus("error");
      unsubscribe();
      return;
    }

    try {
      await send("thread/realtime/start", {
        threadId,
        outputModality: "audio",
        transport: { type: "webrtc", sdp: finalSdp },
      });
    } catch (e) {
      const message = (e as Error).message;
      if (message.includes("does not support realtime conversation")) {
        setError(
          "This thread's model does not support realtime conversation. Start a new thread with a realtime-capable model from the dropdown and try again.",
        );
      } else {
        setError(`thread/realtime/start failed: ${message}`);
      }
      setVoiceStatus("error");
      unsubscribe();
      return;
    }
  }, [send, threadId, onSdpNotification]);

  const stopVoice = useCallback(async () => {
    try {
      await send("thread/realtime/stop", { threadId });
    } catch {}
    pcRef.current?.close();
    pcRef.current = null;
    if (audioRef.current) {
      audioRef.current.srcObject = null;
    }
    setVoiceStatus("idle");
  }, [send, threadId]);

  return { voiceStatus, error, startVoice, stopVoice };
}
