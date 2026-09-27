import type { Draft } from "./shared";

// Publishing controls arrive with Phase 3.
export function PublishControls(_: { draft: Draft; onChange: (d: Draft) => void }) {
  return null;
}
