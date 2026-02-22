import { useRef, useCallback, useState } from "react";
import type { ServerMessage } from "../types/session";

const MSG_CONTROL = 0x00;
const MSG_AUDIO = 0x01;

export function useWebSocket(onMessage: (msg: ServerMessage) => void) {
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

  const connect = useCallback(() => {
    return new Promise<void>((resolve, reject) => {
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(
        `${protocol}//${window.location.host}/ws/audio`,
      );
      ws.binaryType = "arraybuffer";

      ws.onopen = () => {
        setConnected(true);
        wsRef.current = ws;
        resolve();
      };

      ws.onmessage = (event) => {
        if (typeof event.data === "string") {
          onMessageRef.current(JSON.parse(event.data) as ServerMessage);
        }
      };

      ws.onclose = () => {
        setConnected(false);
        wsRef.current = null;
      };

      ws.onerror = () => {
        reject(new Error("WebSocket connection failed"));
      };
    });
  }, []);

  const disconnect = useCallback(() => {
    wsRef.current?.close();
    wsRef.current = null;
  }, []);

  const sendControl = useCallback((msg: object) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const json = new TextEncoder().encode(JSON.stringify(msg));
    const packet = new Uint8Array(1 + json.length);
    packet[0] = MSG_CONTROL;
    packet.set(json, 1);
    ws.send(packet);
  }, []);

  const sendAudio = useCallback((samples: Float32Array) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const bytes = new Uint8Array(samples.buffer);
    const packet = new Uint8Array(1 + bytes.length);
    packet[0] = MSG_AUDIO;
    packet.set(bytes, 1);
    ws.send(packet);
  }, []);

  return { connect, disconnect, sendControl, sendAudio, connected };
}
