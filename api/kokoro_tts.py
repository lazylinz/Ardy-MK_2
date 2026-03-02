import argparse
import sys
import wave

import numpy as np
from kokoro_onnx import Kokoro


def to_int16_mono(samples: np.ndarray) -> np.ndarray:
    arr = np.asarray(samples)
    if arr.ndim == 2:
        arr = arr[:, 0]
    arr = np.clip(arr, -1.0, 1.0)
    return (arr * 32767.0).astype(np.int16)


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate WAV speech with Kokoro ONNX")
    parser.add_argument("--model", required=True, help="Path to kokoro-v1.0.onnx")
    parser.add_argument("--voices", required=True, help="Path to voices-v1.0.bin")
    parser.add_argument("--voice", default="am_adam", help="Voice id (e.g., am_adam)")
    parser.add_argument("--lang", default="en-us", help="Language code (e.g., en-us)")
    parser.add_argument("--speed", type=float, default=1.0, help="Speech speed")
    parser.add_argument("--output", required=True, help="Target wav output path")
    args = parser.parse_args()

    text = sys.stdin.read().strip()
    if not text:
        raise ValueError("No text provided for synthesis.")

    kokoro = Kokoro(args.model, args.voices)
    samples, sample_rate = kokoro.create(text, voice=args.voice, speed=args.speed, lang=args.lang)
    pcm16 = to_int16_mono(samples)

    with wave.open(args.output, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(int(sample_rate))
        wf.writeframes(pcm16.tobytes())

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
