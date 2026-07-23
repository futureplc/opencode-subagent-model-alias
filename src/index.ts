/**
 * Dispatch subagents on an allow-listed model by appending "@<alias>" to
 * subagent_type in the native task tool, e.g. "review/security@terra".
 *
 * Hook flow:
 *   tool.definition     — documents the @alias convention on the task tool
 *   tool.execute.before — strips the suffix, annotates the description, records the pending dispatch
 *   chat.message        — matches the child's first message (parentage, agent,
 *                         title) and rewrites its model; consumes the dispatch
 *   tool.execute.after  — warns in the task output if the swap never happened
 *
 * The full model reference is appended to the aliased task description, which
 * persists in the parent task history. The model choice otherwise lives only
 * in plugin memory.
 *
 * See README.md for design notes and caveats.
 */

import type { Plugin } from "@opencode-ai/plugin"
import type { UserMessage } from "@opencode-ai/sdk"

const PENDING_TTL_MS = 10 * 60 * 1000

type ModelEntry = {
  /** Alias used as the @suffix, e.g. "terra". */
  name: string
  /** Full model reference, "provider/model-id". */
  model: string
  /** Guidance for the agent on when to pick this model. */
  when?: string
}

type PendingDispatch = {
  /** Task tool call that issued the dispatch; key of this entry in `pending`. */
  callID: string
  /** Session that issued the task call; the child must be its direct child. */
  parentID: string
  /** Agent the task call resolved to (alias already stripped). */
  agent: string
  /** Expected child session title; tells same-turn dispatches apart. */
  title: string
  entry: ModelEntry
  created: number
  consumed: boolean
  background: boolean
}

export const SubagentModelAlias: Plugin = async ({ client }, options) => {
  // Console output overlays the TUI, so report via toast + log file.
  // Fire-and-forget: reporting must never block or fail a hook.
  function report(message: string, level: "warn" | "error" = "error") {
    void client.tui
      .showToast({ body: { message: `subagent-model-alias: ${message}`, variant: level === "warn" ? "warning" : "error" } })
      .catch(() => {})
    void client.app.log({ body: { service: "subagent-model-alias", level, message } }).catch(() => {})
  }

  const models = (Array.isArray(options?.models) ? options.models : []) as ModelEntry[]
  const byName = new Map<string, ModelEntry>()
  for (const entry of models) {
    // Alias names are interpolated into a regex; keep them plain.
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(entry.name)) {
      report(`alias "${entry.name}" is invalid (use letters, digits, - or _) — skipped`)
      continue
    }
    byName.set(entry.name, entry)
  }
  if (byName.size === 0) {
    report("no valid models configured — pass options.models in opencode.json; plugin disabled")
    return {}
  }

  function parseModel(ref: string) {
    const [providerID, ...rest] = ref.split("/")
    return { providerID: providerID!, modelID: rest.join("/") }
  }

  /** Pending dispatches by callID; consumed by chat.message, verified by tool.execute.after. */
  const pending = new Map<string, PendingDispatch>()
  /** Swapped sessions, so follow-up messages (task_id resume) stay on the swapped model. LRU-bounded. */
  const sticky = new Map<string, ModelEntry>()
  const STICKY_MAX = 500

  function remember(sessionID: string, entry: ModelEntry) {
    // Re-insert so Map iteration order doubles as LRU order.
    sticky.delete(sessionID)
    sticky.set(sessionID, entry)
    if (sticky.size > STICKY_MAX) {
      const oldest = sticky.keys().next().value
      if (oldest !== undefined) sticky.delete(oldest)
    }
  }

  function prune(now: number) {
    for (const [callID, item] of pending) {
      if (now - item.created > PENDING_TTL_MS) pending.delete(callID)
    }
  }

  /** Session parentage and creation title are immutable; cache them so matching costs one lookup per session. */
  const sessionInfo = new Map<string, { parentID?: string; title?: string }>()
  const SESSION_INFO_MAX = 500

  async function getSessionInfo(sessionID: string) {
    const cached = sessionInfo.get(sessionID)
    if (cached) return cached
    const result = await client.session.get({ path: { id: sessionID } }).catch(() => undefined)
    const data = result?.data
    if (!data) return undefined // transient failures are not cached
    const info = { parentID: data.parentID, title: data.title }
    sessionInfo.set(sessionID, info)
    if (sessionInfo.size > SESSION_INFO_MAX) {
      const oldest = sessionInfo.keys().next().value
      if (oldest !== undefined) sessionInfo.delete(oldest)
    }
    return info
  }

  const aliasPattern = new RegExp(`^(.+)@(${[...byName.keys()].join("|")})$`)
  const modelDoc = [...byName.values()]
    .map((entry) => `- "@${entry.name}" (${entry.model}): ${entry.when ?? "no guidance configured"}`)
    .join("\n")

  function applyModel(message: UserMessage, entry: ModelEntry) {
    const { providerID, modelID } = parseModel(entry.model)
    // The runtime model carries a variant the published SDK type does not declare.
    const model = message.model as UserMessage["model"] & { variant?: string }
    model.providerID = providerID
    model.modelID = modelID
    // A variant computed for the original model may not exist on the target.
    model.variant = undefined
  }

  return {
    "tool.definition": async (input, output) => {
      if (input.toolID !== "task") return
      output.description += [
        "",
        "",
        "Model selection: subagent_type accepts an optional @alias suffix to run",
        "the subagent on a specific model (e.g. 'review/security@" + [...byName.keys()][0] + "').",
        "Use a suffix ONLY when the task clearly warrants a non-default model.",
        "The suffix is consumed during dispatch, so recorded task calls show the",
        "bare subagent_type: a missing suffix in your history means the alias was",
        "applied, not ignored. If a swap fails, the task output includes a warning.",
        "Available aliases and when to use them:",
        modelDoc,
      ].join("\n")
    },

    "tool.execute.before": async (input, output) => {
      if (input.tool !== "task") return
      const now = Date.now()
      prune(now)
      const match = output.args.subagent_type?.match(aliasPattern)
      if (!match) return
      const agent = match[1]!
      const entry = byName.get(match[2]!)!
      // Mutate properties only — replacing output.args is ignored by the core.
      output.args.subagent_type = agent
      if (typeof output.args.description === "string") {
        output.args.description = output.args.description ? `${output.args.description} (${entry.model})` : `(${entry.model})`
      }
      pending.set(input.callID, {
        callID: input.callID,
        parentID: input.sessionID,
        agent,
        // Matches the task tool's child session title. Assumes subagent_type is
        // exactly the resolved agent's registry name (agent lookup is exact-match).
        title: `${output.args.description} (@${agent} subagent)`,
        entry,
        created: now,
        consumed: false,
        background: output.args.background === true,
      })
    },

    "chat.message": async (input, output) => {
      prune(Date.now())
      const unconsumed = [...pending.values()].filter(
        (item) => !item.consumed && (input.agent === undefined || input.agent === item.agent),
      )
      if (unconsumed.length > 0) {
        const session = await getSessionInfo(input.sessionID)
        // A dispatch is only honored in a direct child of the dispatching
        // session with the expected agent and title. Re-check consumed: an
        // interleaved message may have consumed an entry during the lookup.
        const matches = session?.parentID
          ? unconsumed.filter(
              (item) => !item.consumed && item.parentID === session.parentID && item.title === session.title,
            )
          : []
        if (matches.length > 0) {
          if (matches.length > 1)
            report(
              `${matches.length} concurrent dispatches to "${matches[0]!.agent}" are indistinguishable (same parent and description) — applying the oldest`,
              "warn",
            )
            const item = matches[0]! // Map iteration order → oldest first
            applyModel(output.message, item.entry)
            item.consumed = true
          // Background dispatches get no receipt check, so the entry is done.
          if (item.background) pending.delete(item.callID)
          remember(input.sessionID, item.entry)
          return
        }
      }

      const remembered = sticky.get(input.sessionID)
      if (remembered) {
        applyModel(output.message, remembered)
        remember(input.sessionID, remembered)
      }
    },

    "tool.execute.after": async (input, output) => {
      if (input.tool !== "task") return
      const item = pending.get(input.callID)
      if (!item) return
      // Background dispatches return before the child's first message may
      // exist; chat.message consumes and deletes the entry (or the TTL prunes it).
      if (item.background) return
      pending.delete(input.callID)
      if (item.consumed) return
      // A task_id resume of a session already sticky on the requested model ran
      // correctly even though nothing was newly applied.
      const childID = (output.metadata as { sessionId?: string } | undefined)?.sessionId
      if (childID && sticky.get(childID)?.model === item.entry.model) return
      const warning =
        `[subagent-model-alias] WARNING: the model swap to ${item.entry.model} (@${item.entry.name}) was never applied — ` +
        `this task ran on the DEFAULT model. Report this to the user; do not assume the requested model was used.`
      report(`swap to ${item.entry.model} (@${item.entry.name}) was never applied — task ran on the default model`, "warn")
      if (typeof output.output === "string") output.output = `${warning}\n\n${output.output}`
    },
  }
}
