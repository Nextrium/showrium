// Voice notes: settings that help speech-to-text hear names and accents right, and a check that
// refuses a transcript that's mostly noise (so posts are never written from "… … …").

export type TranscriptCheck = { ok: true } | { ok: false; reason: string };

/**
 * Options for Whisper: English, silence skipped, no repetition loops, and a short hint made of the
 * person's own words (name, role, expertise) plus any names they type for this note.
 */
export function whisperOptions(persona: { displayName?: string; role?: string; expertise?: string[]; interests?: string[] } | null, hint = "") {
  const words = [hint.trim(), persona?.displayName, persona?.role, ...(persona?.expertise ?? []), ...(persona?.interests ?? [])]
    .map((w) => (w ?? "").replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const initial = words.join(", ").slice(0, 400);
  return {
    language: "en",
    vad_filter: true,
    condition_on_previous_text: false,
    hallucination_silence_threshold: 2,
    ...(initial ? { initial_prompt: `Names and terms that may come up: ${initial}.` } : {}),
  };
}

/** Whether a transcript has enough real words to write from. */
export function checkTranscript(text: string): TranscriptCheck {
  const t = text.trim();
  const words = t.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? [];
  if (words.length < 4) return { ok: false, reason: "We couldn't hear enough speech in that recording." };
  // Gaps Whisper marks as "..." when it can't make out the words.
  const gaps = (t.match(/\.{3}|…/g) ?? []).length;
  if (gaps >= 4 && gaps / words.length > 0.15) return { ok: false, reason: "Much of the recording was unclear (it came out as “…”)." };
  // Hallucination loops: the same short phrase over and over.
  const lower = words.map((w) => w.toLowerCase());
  const trigrams = new Map<string, number>();
  for (let i = 0; i + 2 < lower.length; i++) {
    const k = lower.slice(i, i + 3).join(" ");
    trigrams.set(k, (trigrams.get(k) ?? 0) + 1);
  }
  const top = Math.max(0, ...trigrams.values());
  if (lower.length >= 15 && top >= 4 && top / (lower.length - 2) > 0.2) return { ok: false, reason: "The transcript repeats itself, which usually means the recording was unclear." };
  return { ok: true };
}
