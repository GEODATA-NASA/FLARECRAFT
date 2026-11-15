"""Mark Flick's voice clips as SI-generated in their metadata (an ID3v2.3 comment and title), as the Space Apps SI rules
ask for audio. Idempotent: clips that already carry the tag are skipped.   python release/tag_voice.py <audio folder> ..."""
import struct
import sys
from pathlib import Path

NOTE = "SI-generated speech: Microsoft Edge neural text-to-speech (en-US-AnaNeural) reading lines written for GeoFlare by Team FLARECRAFT with Claude."


def frame(fid, payload):
    return fid.encode() + struct.pack(">I", len(payload)) + b"\x00\x00" + payload


def synchsafe(n):
    return bytes([(n >> 21) & 0x7F, (n >> 14) & 0x7F, (n >> 7) & 0x7F, n & 0x7F])


def tag(path):
    data = path.read_bytes()
    if NOTE.encode("utf-16")[2:20] in data[:4096] or b"SI-generated" in data[:4096]:
        return False
    if data[:3] == b"ID3":                                       # replace an existing tag
        size = (data[6] << 21) | (data[7] << 14) | (data[8] << 7) | data[9]
        data = data[10 + size:]
    text = lambda s: b"\x01" + s.encode("utf-16")                # UTF-16 with BOM
    frames = (frame("TIT2", text("Flick's voice (SI-generated)")) + frame("TPE1", text("Flick (SI-generated voice)"))
              + frame("COMM", b"\x00eng\x00" + NOTE.encode("latin-1")))
    path.write_bytes(b"ID3\x03\x00\x00" + synchsafe(len(frames)) + frames + data)
    return True


if __name__ == "__main__":
    done = sum(tag(p) for folder in sys.argv[1:] for p in sorted(Path(folder).glob("*.mp3")))
    print(f"tagged {done} clips")
