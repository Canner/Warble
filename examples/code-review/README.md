# Code review from an explicit input list

Write the reviewer behavior in [`profile.yml`](profile.yml). Supply the diff and
its context as ordinary files, separate from the harness. No semantic context,
handwritten IR, custom input schema or runner is required. The prompt and request
use Traditional Chinese; edit their language to suit your reviewers.

## Check, preview and build

From the repository root, with the current `warble` binary on your PATH:

```sh
warble check examples/code-review --target claude-code:headless
warble preview examples/code-review --target claude-code:headless
warble build examples/code-review --target claude-code:headless --out review-agent
```

`review-agent` must not already exist. Preview shows the exact native instruction
files and their sources, plus generated permissions. These commands do not start
a model. The `strong` tier defaults to `opus`; pass the same `--strong` choice to
preview and build if you want a different mapping.

Build emits the agent, not the review inputs. Copy the inputs explicitly:

```sh
cp examples/code-review/INPUTS.txt examples/code-review/REVIEW_SCOPE.txt examples/code-review/REQUEST.txt review-agent/
cp -R examples/code-review/inputs review-agent/inputs
```

Read [`INPUTS.txt`](INPUTS.txt), [`REVIEW_SCOPE.txt`](REVIEW_SCOPE.txt) and
[`REQUEST.txt`](REQUEST.txt). The inventory lists actual files, not directories.
The scope defines the intended behavior, changed files and accepted limits.
Neither file is a Warble configuration format or a filesystem access boundary.

## Start the native CLI yourself

Install and authenticate Claude Code, inspect the generated `RUN.md` and native
files, then start the selected agent from the output directory. This step calls
a model and may incur usage charges:

```sh
cd review-agent
claude -p "$(cat REQUEST.txt)" --agent review_changes < /dev/null
```

Redirecting stdin prevents unrelated piped input from joining the request. To
use an interactive session instead, run `claude --agent review_changes` and paste
`REQUEST.txt`. You can also build `claude-code:interactive` into a separate new
output directory and copy the same inputs there.

The generated agent exposes `Read`. Its input-list and read-only prompt rules are
instructions, not a sandbox. The native settings' `allow` entries pre-approve
calls; they are not a session-wide tool whitelist. If Claude reports an untrusted
workspace and ignores those entries, review and accept the directory's trust
prompt in an interactive session before relying on project pre-approvals. This
example does not override your host's managed policies or other customizations.

## Review your own change

Replace `inputs/change.diff` and both source snapshots together. Update the input
inventory with every supplied file; identify excerpts and their original line
numbers. Update the scope with the revisions, intended behavior, contracts,
accepted limits and missing dependencies. Keep old verdicts, unrelated files and
credentials out of the packet. The same harness can then review the new input.

The included shipping example is deliberately synthetic: its rewrite changes the
boundary behavior at a subtotal of 50. It is a small practice case, not production
code or a model accuracy benchmark. A reviewer should cite source evidence and
state that it did not execute tests. There is no expected-response file in the
review inputs, and model findings always need verification.

For a smaller starting point, see [First harness](../first-harness/README.md).
