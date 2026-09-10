/**
 * The parts of the agent envelope this harness fixes, whatever a profile declares.
 *
 * These live here rather than beside the agent because two very different modules need the same
 * facts and must not restate them: `agent.ts` enforces them at run time, and `report-build.ts`
 * DISCLOSES them in a finished run's warnings. A report that names the disallowed built-ins in its
 * own prose would go stale the first time this list changed, and a stale disclosure is worse than
 * none — it is a specific false claim about what a number measured. Importing `agent.ts` for them
 * is not an option: it pulls the Claude Agent SDK in, and report building is offline by design.
 */

/**
 * Built-in tools the benchmark's action space excludes. The benchmark serves its own nine charged
 * tools and nothing else; a profile that declares more capabilities is granted none of them.
 */
export const DISALLOWED_BUILT_INS = Object.freeze([
  "Bash",
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "Task",
  "TodoWrite",
  "NotebookEdit",
  "Skill",
  "AskUserQuestion",
]);

/**
 * The one component id the runner looks up in a compiled profile's IR. A profile that mounts its
 * analytical component under any other id fails the run rather than being discovered, and a
 * multi-component composition is not loaded: the system prompt is this component's alone.
 */
export const BIRD_COMPONENT_ID = "bird_interact";
