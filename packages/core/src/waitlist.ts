import { waitlistEntry, type Db } from "@nextrium/db";
import { newId } from "./ids.js";

/**
 * Adds an email to the waitlist. Idempotent: joining twice changes nothing.
 * Callers must give the same response either way, so the endpoint can't be used
 * to find out whether someone has signed up.
 */
export async function joinWaitlist(db: Db, email: string, source = "website"): Promise<void> {
  await db
    .insert(waitlistEntry)
    .values({ id: newId("wl"), email: email.trim().toLowerCase(), source })
    .onConflictDoNothing({ target: waitlistEntry.email });
}
