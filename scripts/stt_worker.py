"""Speech-to-text worker for BananaVinci (faster-whisper).

usage: python scripts/stt_worker.py <audio.wav> <out.json> [--model small.en] [--language en]

Writes JSON: { engine, model, language, duration, segments: [ { start, end, text, words: [ { start, end, word, p } ] } ] }
Prints "PROGRESS <0..1>" lines on stdout so the caller can show progress.
"""
import argparse
import json
import os
import sys


def load_model(name):
    from faster_whisper import WhisperModel

    # Prefer the GPU; fall back to CPU if CUDA libraries are missing.
    for device, compute in (("cuda", "float16"), ("cpu", "int8")):
        try:
            return WhisperModel(name, device=device, compute_type=compute), device
        except Exception as e:  # noqa: BLE001
            print(f"INFO could not use {device}: {e}", file=sys.stderr, flush=True)
    raise SystemExit("no usable device for faster-whisper")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("audio")
    ap.add_argument("out")
    ap.add_argument("--model", default="small.en")
    ap.add_argument("--language", default=None)
    args = ap.parse_args()

    model, device = load_model(args.model)
    print(f"INFO model={args.model} device={device}", flush=True)
    segments, info = model.transcribe(
        args.audio,
        language=args.language,
        word_timestamps=True,
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 400},
        beam_size=5,
        condition_on_previous_text=False,
    )
    total = info.duration or 1.0
    out = []
    for seg in segments:
        words = [
            {"start": round(w.start, 3), "end": round(w.end, 3), "word": w.word.strip(), "p": round(w.probability, 3)}
            for w in (seg.words or [])
            if w.word.strip()
        ]
        out.append({"start": round(seg.start, 3), "end": round(seg.end, 3), "text": seg.text.strip(), "words": words})
        print(f"PROGRESS {min(1.0, seg.end / total):.3f}", flush=True)
    result = {
        "engine": f"faster-whisper ({device})",
        "model": args.model,
        "language": info.language,
        "duration": round(total, 3),
        "segments": out,
    }
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False)
    print("PROGRESS 1.000", flush=True)
    hard_exit()  # while the model is still alive: freeing it is what crashes


def hard_exit():
    """Exit without any teardown.

    On Windows, freeing the Whisper model / unloading the CUDA libraries can crash the process
    (0xC0000409) after the result is already written, which made the caller report a failure.
    Even os._exit still runs DLL detach on Windows, so terminate the process outright there.
    """
    sys.stdout.flush()
    sys.stderr.flush()
    if sys.platform == "win32":
        import ctypes

        k32 = ctypes.windll.kernel32
        k32.GetCurrentProcess.restype = ctypes.c_void_p
        k32.TerminateProcess.argtypes = (ctypes.c_void_p, ctypes.c_uint)
        k32.TerminateProcess(k32.GetCurrentProcess(), 0)
    os._exit(0)


if __name__ == "__main__":
    main()
