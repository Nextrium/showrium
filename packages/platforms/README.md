# packages/platforms

One adapter per social platform: signing in (OAuth), posting text, threads and images, and reading what the platform allows.

- Official APIs only, never scraping.
- Errors carry the platform's own reason from its structured fields; tokens are never echoed.
- Tests use fake platform responses, including error responses. Tests never post to a real account.
