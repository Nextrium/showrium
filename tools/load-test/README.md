# Load test

[k6](https://grafana.com/docs/k6/latest/set-up/install-k6/) script for the Showrium API. **Preview only, never production.**

```bash
k6 run -e BASE_URL=https://preview.showrium.com -e API_KEY=<a preview workspace key> tools/load-test/showrium.k6.js
```

- `public`: health and config at 20 requests per second for a minute.
- `reads` (with `API_KEY`): five authenticated reads, 5 times a second.
- `compose` (add `-e COMPOSE=1`): one AI compose every 10 seconds. It costs real AI credits.

It passes when there are no 5xx responses and the 95th-percentile latency is under 800 ms (20 s for compose).
429s are expected from a single machine (120 requests a minute per IP) and are counted as `rate_limited`.
To measure raw throughput, run from several machines. Don't raise the limits.

Delete the load-test workspace's drafts afterwards, or use a throwaway workspace.
