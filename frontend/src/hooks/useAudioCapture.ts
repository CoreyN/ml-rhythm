import { useRef, useCallback } from "react";

interface UseAudioCaptureOptions {
  onAudioChunk: (samples: Float32Array) => void;
}

export function useAudioCapture({ onAudioChunk }: UseAudioCaptureOptions) {
  const contextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const onChunkRef = useRef(onAudioChunk);
  onChunkRef.current = onAudioChunk;

  const chunksRef = useRef<Float32Array[]>([]);

  const start = useCallback(async (): Promise<number> => {
    chunksRef.current = [];

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });

    const context = new AudioContext();
    if (context.state === "suspended") {
      await context.resume();
    }
    await context.audioWorklet.addModule("/audio-worklet-processor.js");

    const source = context.createMediaStreamSource(stream);
    const workletNode = new AudioWorkletNode(
      context,
      "audio-stream-processor",
    );

    workletNode.port.onmessage = (event) => {
      const samples = event.data as Float32Array;
      chunksRef.current.push(new Float32Array(samples));
      onChunkRef.current(samples);
    };

    const silence = context.createGain();
    silence.gain.value = 0;
    source.connect(workletNode);
    workletNode.connect(silence);
    silence.connect(context.destination);

    contextRef.current = context;
    streamRef.current = stream;

    return context.sampleRate;
  }, []);

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    contextRef.current?.close();
    streamRef.current = null;
    contextRef.current = null;
  }, []);

  const getRecordedAudio = useCallback((): Float32Array | null => {
    const chunks = chunksRef.current;
    if (chunks.length === 0) return null;

    const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
    const result = new Float32Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result;
  }, []);

  return { start, stop, getRecordedAudio };
}
