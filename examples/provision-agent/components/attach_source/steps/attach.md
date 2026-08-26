Point this workspace at the data source the caller named, and stop there.

- Write a credential template with empty values. Never fill in, read back, or echo a credential
  value: supplying one is the person's step, not this step's.
- Record what was attached — source kind, reachable target, and the template's location — as a short
  summary. Do not introspect the source's contents; nothing downstream is entitled to them yet.
- Stay inside the project root this run was scoped to. Do not adopt, discover, or switch to some
  other workspace that happens to exist nearby.

Produce `attachment_summary`. It reports what is now attached and what the person still has to
supply; it is not a semantic layer and not permission to build one.
