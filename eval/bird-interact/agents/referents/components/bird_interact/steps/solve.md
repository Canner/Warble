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

## Resolve referents before you compute

A request names things: quantities, groupings, populations, entities, boundaries. Every one of them
has to land on something specific in this database — a column, the rows of a table, a filtered
subset. Correct arithmetic over the wrong referent produces a confident wrong answer, and the scorer
sees only the answer.

So before you write SQL, list every noun and noun phrase in the request and state, for each, the
exact thing it maps to:

    <phrase from the request> -> <a column, or the rows of a table, or the subset where <condition>>

Write the mapping as a schema-grounded expression — a column name, a table name, a SQL condition —
never as an English restatement of the phrase. "Recent activity -> the activity table" is not a
mapping. "Recent activity -> rows of events where occurred_at >= <boundary>" is one, and stating it
that way is also what shows you the boundary is still unknown.

Each mapping must come from one of three places, and look in this order:

1. **A definition in the external knowledge base.** Find out which terms are defined at all before
   assuming a phrase is ordinary English — `get_all_external_knowledge_names` costs 0.5 and answers
   that for the whole task at once. A phrase that reads as plain description may be a defined term
   here, and if it is, its definition governs.
2. **The schema.** Column meanings are what decide which of the plausible columns a phrase
   denotes; the plausible-looking one is not always the one meant.
3. **The user.** If a phrase still has two or more schema-grounded readings that would return
   different rows, ask.

A mapping that came from none of the three is a guess.

## When a definition has parts, count them

A definition you retrieved is not applied until every part of it appears in your query. Read the
whole definition, count its distinct conditions, then count the corresponding predicates in your SQL
and check that the two numbers agree.

Conditions written as prose bind exactly as much as conditions written as comparisons. Reading a
definition down to the part that already looks like a `WHERE` clause and stopping there leaves the
rest silently unapplied.

The same holds for any quantity a definition specifies: if the definition says how something is
computed and your query never references it, you have not applied that definition — you have skipped
it.

## Spend asks on referents, not on arithmetic

`ask_user` costs 2 and the user does answer. Spend it on what you cannot derive:

- **Worth asking:** which column or entity a phrase denotes when more than one would fit; what value
  a quantifier stands for when the request states no number and no boundary — such a quantifier is
  unresolved until it is answered or defined, and picking a comparison operator for it yourself is a
  guess with nothing behind it; which rows make up the population the request is about.
- **Not worth asking:** how to compute something the knowledge base defines, or anything the schema
  states. Look those up instead — a definition lookup is 0.5 and a column meaning is 0.5, against the
  ask's 2.

Asking is a tool call, not an announcement. If you need something from the user, call `ask_user` in
this same turn; describing the question you are about to ask leaves you with neither the answer nor
the turn.

## Verify before you spend a submit

`submit_sql` costs 3 and is the only action that can be rejected. A rejected submission takes the 3
coins **and** consumes the attempt that would have let you fix it, so two wrong submissions can end a
task that had budget for three tries. Everything that would have prevented one is cheaper than one.

Before each `submit_sql`, run this check, which costs nothing:

1. Every noun in the request has a stated mapping, and each mapping came from the knowledge base,
   the schema, or the user.
2. Every part of every definition you retrieved appears in the query.
3. The thing being counted or aggregated is the entity the request names — not whichever table you
   happened to join through.
4. Every grouping, filter and boundary traces back to a mapping rather than to a plausible reading.
5. No value in the query is there because it seemed reasonable.

When a check fails, buy the fix rather than the submission: a definition lookup is 0.5, a column
meaning is 0.5, and `execute_sql` at 1 shows you what your query actually returns, which is the
cheapest evidence there is that it returns anything like the right shape.

## Mechanics

You must explicitly call `submit_sql`; plain text is never a submission. If a successful phase-1
submission returns a follow-up query, continue solving phase 2 in this same session with the same
remaining budget — while a phase is still open the task is not finished — then call `submit_sql`
again. When an action is rejected for insufficient budget, immediately submit your best SQL.
