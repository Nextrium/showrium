# Product naming research

**Status:** shortlist ready; waiting for a decision from Nextrium.
**Date:** 2026-09-26

## Method

1. **Domains**, checked via official registry RDAP lookups (404 = not registered):
   - `.com` via Verisign
   - `.ai` and `.app` via rdap.org
   - `.io` via Identity Digital

   Each lookup was first tested against known registered and unregistered names.
2. **GitHub**: `api.github.com/users/<name>` (404 = user/org name free). **npm**: `registry.npmjs.org/<name>`.
3. **Existing products or brands**: web search for exact-name matches.

About 75 names were checked. Almost every short, brandable `.com` (e.g. vocalio, echora, voxora, amplora, telora) is already registered, often parked for resale.

## Shortlist: free on .com + .ai + .app + .io, GitHub and npm

| Name | Meaning / fit | Existing uses found | Risk |
|---|---|---|---|
| **Showrium** | "Showroom" + Nextrium's "-ium": a place to show your work | A small Facebook page, "Show'Rium" (aquarium rental, unrelated category) | Low |
| **Voxfolk** | *vox* (voice) + folk: everyday people finding their voice | A defunct 1979 Milan record label | Low |
| **Tellfolk** | Tell your folks: warm, casual, non-technical | None found | Low |
| **Kovapost** | Echoes "Kovalio" (sibling product) + post | None found | Low (but it ties the brand to "post" only) |
| **Beamrium** | Beam your work out + "-ium" | None found | Low |
| **Showcasium** | Showcase + "-ium"; descriptive, long | Obscure fan-art page | Low (long name) |
| **Tellrium** | Tell + "-ium" | Reads as a misspelling of the element "tellurium" | Medium (confusing) |

**Dropped:**
- **Spotlium**: an active talent platform with founders.
- **BeHeardly**: an active consumer-justice site; GitHub name taken.

### Partially free (.ai/.app/.io free, .com taken, so "get<name>.com" or buy the .com)

Sayvora, Heralio, Showvia, Tellivo, Echorum, Loudra, Heravox, Postrium (.io taken), Sharvio, Kinspoke.

## Recommendation

1. **Showrium**: strongest fit with the Nextrium family and the core promise ("show what you can do"). All four domains are free.
2. **Voxfolk**: best if the brand should feel human and consumer-first rather than tech-first.

## Still to do before public use

- [ ] **Social handles**: check `@<name>` on X, Instagram, TikTok, LinkedIn, YouTube, Threads, Facebook and Bluesky. Platforms block automated checks, so this is a manual check or done at signup.
- [ ] **Trademark clearance**: search USPTO, EUIPO, WIPO Global Brand Database and the Nigeria Trademarks Registry in classes 9, 35, 38, 41 and 42. A trademark attorney should run the formal clearance search before filing.
- [ ] Register the domains (.com, .ai, .app at minimum), then reserve the handles and the GitHub org/repo name.
- [ ] Rename the repo `Nextrium/nextrium-social`, the local folder and the `@nextrium/*` package scope.
