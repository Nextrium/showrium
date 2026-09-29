import { afterEach, describe, expect, it } from "vitest";
import { captionAt, drawCaption, pickMimeType } from "../src/video/render";

const g = globalThis as unknown as { MediaRecorder?: unknown };
const original = g.MediaRecorder;
afterEach(() => {
  g.MediaRecorder = original;
});
const recorderSupporting = (types: string[]) => ({ isTypeSupported: (t: string) => types.includes(t) });

describe("video format (voice-over must be audible in the downloaded file)", () => {
  it("prefers MP4 with AAC sound", () => {
    g.MediaRecorder = recorderSupporting(["video/mp4", "video/mp4;codecs=avc1,mp4a.40.2", "video/webm"]);
    expect(pickMimeType()).toBe("video/mp4;codecs=avc1,mp4a.40.2");
  });

  it("never asks for plain MP4 when that would mean Opus sound inside MP4 (silent in many players)", () => {
    g.MediaRecorder = recorderSupporting(["video/mp4", "video/webm;codecs=vp9,opus", "video/webm"]);
    expect(pickMimeType()).toBe("video/webm;codecs=vp9,opus");
  });

  it("uses plain MP4 only where WebM can't be recorded (Safari, whose MP4 has AAC)", () => {
    g.MediaRecorder = recorderSupporting(["video/mp4"]);
    expect(pickMimeType()).toBe("video/mp4");
  });
});

describe("captions", () => {
  it("splits evenly, with no stray single word at the end", () => {
    const text = "Retries now wait a little longer each time so your database stays calm"; // 13 words
    const seen = new Set([0, 0.25, 0.5, 0.75, 0.99].map((f) => captionAt(text, f)));
    expect([...seen]).toEqual(["Retries now wait a little", "longer each time so", "your database stays calm"]);
  });

  it("are outlined text, with no black box behind them", () => {
    const calls: string[] = [];
    const ctx = {
      save: () => calls.push("save"),
      restore: () => calls.push("restore"),
      measureText: (t: string) => ({ width: t.length * 20 }),
      strokeText: (t: string) => calls.push(`stroke:${t}`),
      fillText: (t: string) => calls.push(`fill:${t}`),
      fillRect: () => calls.push("fillRect"),
    } as unknown as CanvasRenderingContext2D;
    drawCaption(ctx, "Retries now wait a little", 720, 1280, 1, 64, 592);
    expect(calls).not.toContain("fillRect");
    expect(calls.filter((c) => c.startsWith("stroke:"))).toHaveLength(calls.filter((c) => c.startsWith("fill:")).length);
    expect(calls.filter((c) => c.startsWith("fill:")).join(" ")).toContain("Retries");
  });
});
