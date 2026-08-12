The service paused to ask something before it can finish. Its turn is still open and waiting on you.

Read `remote_answer.question` and `remote_answer.options`, pick the option the user's original
message most plainly implies, and send it with the `remote_agent__answer_clarification` tool —
passing `thread_response_id` and `question_id` exactly as they came back. The tool returns once the
service has resumed and produced its answer.

Choose; do not deflect. Bouncing the question back to the user is the right move only when the
options are genuinely equally plausible given what they asked — in which case say so plainly, quote
the options, and stop rather than guessing. When one option is the obvious reading, take it and note
which one you took in your answer.

Emit `resolved_answer` in the same shape as `remote_answer`, now carrying the finished result.
