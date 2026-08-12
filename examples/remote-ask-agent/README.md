# remote-ask-agent

The delegating example: a profile whose analysis happens somewhere else.

Every other example under `examples/` answers the question on the machine the agent runs on, with
the semantic layer one `wren` call away. This one splits the work across a boundary. The local agent
reads the question, decides what to ask, and hands it to an **external agent service**; that service
does the semantic reasoning and the querying and hands back an answer. The local model never sees a
row, which is why all three of its steps sit on the `cheap` tier.

The point is what the profile *doesn't* say. `remote_ask` declares one capability —
`remote_agent_ask` — and no endpoint, no server name, no protocol. Which service is on the other end
is settled at dispatch by the target, exactly like `notify_channel` never names Slack.

## The three steps

| step | tier | what it does |
| --- | --- | --- |
| `classify_intent` | cheap | route the message: delegate · follow up an open thread · answer locally |
| `delegate_ask` | cheap | hand the question over, report what comes back verbatim |
| `answer_clarification` | cheap | conditional — answer a question the service asked back |

The third step is the shape worth copying. A remote turn that pauses to ask *"order date or delivery
date?"* has not failed, so `on_failure` would be the wrong guard; `delegate_ask` reports the pause as
a flag on its own artifact and `on_flag(remote_answer.needs_clarification)` picks it up.

## Running it

```bash
warble compile examples/remote-ask-agent -o ir.json
warble dispatch ir.json --target claude-code:interactive --out agent \
       --models-config models.yaml            # tiers: { cheap: <a small model> }
```

Dispatch grants the agent two MCP tools, `mcp__remote_agent__ask` and
`mcp__remote_agent__answer_clarification`, and nothing else beyond `Read` — no `Bash`, no `Write`.
Delegation is realized as an MCP tool rather than a shell wrapper precisely so the read-only surface
survives it (see `docs/spec/capability-model.md` §7.2).

**You supply the server.** Warble grants the tool names; registering something that answers them is
host configuration. Copy `mcp.json.template` to `agent/.mcp.json`, point it at an MCP server that
exposes `ask` and `answer_clarification` over stdio, and run `claude` from that directory. Keep the
server key as `remote_agent` — the granted tool names are derived from it.

The two tools are expected to return JSON in the shape `delegate_ask.md` documents: an answer plus
`thread_id` / `thread_response_id` for continuing the conversation, optional `sql` / `columns` /
`rows`, and the `needs_clarification` flag with its `question_id`, `question` and `options`.

## Why the context binding is `external`

The semantic layer is wherever the answers come from, so the profile binds `kind: external`: warble
reads nothing, `project` is a locator, and the bound context answers no precondition at all. That is
also why `remote_ask` declares no schema preconditions — over an `external` binding they would be
*unanswerable* by construction, which is the honest outcome rather than a bug.

This example used to bind a local wren project as a stand-in, and that was worse than binding
nothing. Nothing checks a stand-in against the layer that actually answers. The one it named shared
zero models with the service it was pointed at, so the schema digest described a different domain
entirely — and asked "how many committees are there?", the routing model replied that **there is no
committees table**, about a service that held hundreds of them. A missing digest costs the routing step its
vocabulary; a wrong one costs correctness.

A host that *can* read its service's schema binds its own kind instead, resolved through the
`ContextResolver` it passes to `compile_project_to_ir_with`, with whatever extra fields it declares
(a pulled snapshot path, a schema hash to compare against). **Compile stays offline and
credential-free either way** — that is a property of the seam, not of this binding.
