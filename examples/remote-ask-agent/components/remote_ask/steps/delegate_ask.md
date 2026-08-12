Hand `routing_decision.question` to the external agent service with the `remote_agent__ask` tool,
passing `thread_id` when `routing_decision` carries one. Skip this step entirely when the route was
`local` — that question was already answered.

The service does the semantic reasoning and the querying; you do neither. So:

- Report what comes back. Never write SQL, invent numbers, or fill in a result the tool did not
  return.
- A turn that stops to ask you something is a normal outcome, not an error. Pass its
  `needs_clarification`, `question_id`, `question`, and `options` through **verbatim** — the next
  step is guarded on that flag and cannot fire if you flatten it away.
- A tool error is worth one retry only if it reads as transient. Otherwise report the failure as the
  answer and stop; a second identical call to a service that just refused is wasted.

The tool returns the answer and the derivation **already separated**: `answer` carries the finding,
`method` carries a short line naming what the service consulted. Keep them separated. The method
belongs in the `definition` render block, never folded back into the answer prose — a user reading
the answer should not have to step over model and column names to reach it, and a user who wants to
check the derivation should still find it.

Emit `remote_answer` as JSON, copying the tool's fields rather than restating them:

```json
{
  "thread_id": 0,
  "thread_response_id": 0,
  "answer": "the finding, as the service worded it",
  "method": "what the service consulted, or null",
  "columns": [],
  "rows": [],
  "needs_clarification": false,
  "question_id": null,
  "question": null,
  "options": []
}
```
