"""WebSocket route for audio streaming and processing."""

from __future__ import annotations

import json
import traceback

import numpy as np
from litestar import WebSocket, websocket, get

from audio.pipeline import AudioPipeline
from audio.calibration import extract_profile

MSG_CONTROL = 0x00
MSG_AUDIO = 0x01


@websocket("/ws/audio")
async def audio_ws_handler(socket: WebSocket) -> None:
    """
    Protocol:
      Client sends binary frames with a 1-byte prefix:
        0x00 + JSON  →  control message (start / stop / calibrate / stop_calibration)
        0x01 + PCM   →  Float32 audio samples
      Server sends JSON text frames (events, report, calibration_result).
    """
    await socket.accept()
    pipeline: AudioPipeline | None = None

    # Calibration state
    cal_buffer: np.ndarray | None = None
    cal_sample_rate: int = 44100
    cal_step: str | None = None  # "metronome" or "guitar"

    audio_msg_count = 0
    try:
        while True:
            data: bytes = await socket.receive_data(mode="binary")
            if len(data) < 1:
                continue

            msg_type = data[0]
            payload = data[1:]

            if msg_type == MSG_CONTROL:
                msg = json.loads(payload.decode())
                print(f"[WS] control: {msg}")

                if msg["type"] == "calibrate":
                    cal_step = msg.get("step", "metronome")
                    cal_sample_rate = msg.get("sample_rate", 44100)
                    cal_buffer = np.array([], dtype=np.float32)
                    audio_msg_count = 0
                    await socket.send_data(
                        json.dumps({"type": "calibration_started", "step": cal_step}),
                        mode="text",
                    )

                elif msg["type"] == "stop_calibration":
                    if cal_buffer is not None and len(cal_buffer) > 0:
                        try:
                            profile = extract_profile(cal_buffer, cal_sample_rate)
                            await socket.send_data(
                                json.dumps({
                                    "type": "calibration_result",
                                    "step": cal_step,
                                    "profile": profile,
                                }),
                                mode="text",
                            )
                        except Exception as e:
                            traceback.print_exc()
                            await socket.send_data(
                                json.dumps({
                                    "type": "calibration_result",
                                    "step": cal_step,
                                    "error": f"Calibration analysis failed: {e}",
                                }),
                                mode="text",
                            )
                    else:
                        await socket.send_data(
                            json.dumps({
                                "type": "calibration_result",
                                "step": cal_step,
                                "error": "No audio recorded during calibration",
                            }),
                            mode="text",
                        )
                    cal_buffer = None
                    cal_step = None

                elif msg["type"] == "start":
                    audio_msg_count = 0
                    pipeline = AudioPipeline(
                        grid_resolution=msg.get("grid", "8th"),
                        sample_rate=msg.get("sample_rate", 44100),
                        timing_threshold_ms=msg.get("threshold", 30.0),
                        calibration=msg.get("calibration"),
                    )
                    await socket.send_data(json.dumps({"type": "started"}), mode="text")

                elif msg["type"] == "stop":
                    print(f"[WS] stop — received {audio_msg_count} audio messages, buffer={len(pipeline.audio_buffer) if pipeline else 'N/A'} samples")
                    if pipeline:
                        try:
                            report = pipeline.generate_report()
                        except Exception as e:
                            traceback.print_exc()
                            report = {"type": "session_report", "error": f"Report generation failed: {e}"}
                        await socket.send_data(json.dumps(report), mode="text")
                    else:
                        await socket.send_data(
                            json.dumps({"type": "session_report", "error": "No active session"}),
                            mode="text",
                        )
                    break

            elif msg_type == MSG_AUDIO:
                audio_msg_count += 1
                if len(payload) % 4 != 0:
                    continue  # skip misaligned data
                audio_chunk = np.frombuffer(payload, dtype=np.float32)

                # Route audio to calibration buffer or session pipeline
                if cal_buffer is not None:
                    cal_buffer = np.concatenate([cal_buffer, audio_chunk])
                    if audio_msg_count <= 3 or audio_msg_count % 100 == 0:
                        duration = len(cal_buffer) / cal_sample_rate
                        print(f"[WS] calibration audio #{audio_msg_count}: {duration:.1f}s buffered")
                elif pipeline:
                    if audio_msg_count <= 3 or audio_msg_count % 100 == 0:
                        print(f"[WS] audio #{audio_msg_count}: {len(payload)}B payload, {len(payload)//4} samples")
                    events = pipeline.process_audio(audio_chunk)
                    for event in events:
                        await socket.send_data(json.dumps(event), mode="text")

            else:
                if audio_msg_count == 0:
                    print(f"[WS] unhandled: type=0x{msg_type:02x}, {len(payload)}B, pipeline={'yes' if pipeline else 'no'}")

    except Exception as e:
        traceback.print_exc()
        # Try to send error report before closing
        try:
            await socket.send_data(
                json.dumps({"type": "session_report", "error": f"Server error: {e}"}),
                mode="text",
            )
        except Exception:
            pass
    finally:
        await socket.close()


@get("/health")
async def health_check() -> dict:
    return {"status": "ok"}
