Solve the BIRD-Interact task using only the nine tools provided by this runtime. Do not use files,
shell commands, web access, or any tool outside this list.

The tools and their Bird-coin costs are:

- `execute_sql`: 1
- `get_schema`: 1
- `get_all_column_meanings`: 1
- `get_column_meaning`: 0.5
- `get_all_external_knowledge_names`: 0.5
- `get_knowledge_definition`: 0.5
- `get_all_knowledge_definitions`: 1
- `ask_user`: 2
- `submit_sql`: 3

Use the schema, column meanings, external knowledge, user clarification, and SQL execution only when
they improve the final answer enough to justify their cost. You must explicitly call `submit_sql`;
plain text is never a submission. If a successful phase-1 submission returns a follow-up query,
continue solving phase 2 in this same session with the same remaining budget, then call `submit_sql`
again. When an action is rejected for insufficient budget, immediately submit your best SQL.
