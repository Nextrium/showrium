import { useState } from "react";
import { api, navigate, useApi } from "../lib";
import { Alert, Button, Icon, LinkButton, Panel } from "../ui/kit";

type Prompt = { question: string; day: string; answeredContextId: string | null };

/** One short question a day, matched to what you do. The answer becomes material and an idea. */
export function DailyPrompt() {
  const { data } = useApi<Prompt>("/prompt");
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!data) return null;

  const save = async (write: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const out = await api<{ contextItemId: string }>("/prompt/answer", { method: "POST", body: JSON.stringify({ answer }) });
      setAnswer("");
      if (write) navigate(`/app/new?context=${out.contextItemId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save your answer.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel title="Today’s question" id="prompt" action={<span className="flex items-center gap-1.5 text-[12.5px] text-muted"><Icon name="comment" size={14} />Daily prompt</span>}>
      <p className="m-0 font-display text-lg font-semibold leading-snug text-ink">{data.question}</p>
      {data.answeredContextId ? (
        <div className="flex flex-wrap items-center gap-3">
          <span className="flex items-center gap-1.5 text-sm text-ok"><Icon name="check" size={15} strokeWidth={2.2} />Answered. It’s in your ideas.</span>
          <LinkButton to={`/app/new?context=${data.answeredContextId}`} variant="secondary" size="sm">Write posts from it</LinkButton>
        </div>
      ) : (
        <>
          <label className="sr-only" htmlFor="prompt-answer">Your answer</label>
          <textarea id="prompt-answer" rows={2} value={answer} maxLength={2000} onChange={(e) => setAnswer(e.target.value)} placeholder="A sentence or two is plenty." />
          {error && <Alert>{error}</Alert>}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={busy || answer.trim().length < 10} onClick={() => save(true)}>Write posts from this</Button>
            <Button size="sm" variant="secondary" disabled={busy || answer.trim().length < 10} onClick={() => save(false)}>Save as an idea</Button>
          </div>
        </>
      )}
    </Panel>
  );
}
