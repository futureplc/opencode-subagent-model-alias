import { describe, expect, test } from "bun:test"
import { SubagentModelAlias } from "../src/index"

const OPTIONS = {
  models: [
    { name: "terra", model: "yourprovider/terra", when: "Deep reasoning." },
    { name: "luna", model: "openai/gpt-5.5-luna", when: "Fast mechanical tasks." },
  ],
}

/**
 * The plugin only touches client.tui.showToast, client.app.log, and
 * client.session.get, so a harness with those three (plus a session table to
 * control parentage and titles) exercises every hook for real.
 */
async function makePlugin(options: unknown = OPTIONS) {
  const toasts: { message: string; variant: string }[] = []
  const logs: { level: string; message: string }[] = []
  const sessions = new Map<string, { parentID?: string; title?: string }>()
  const client = {
    tui: { showToast: async ({ body }: any) => void toasts.push(body) },
    app: { log: async ({ body }: any) => void logs.push(body) },
    session: { get: async ({ path }: any) => ({ data: sessions.get(path.id) }) },
  }
  const hooks = (await SubagentModelAlias({ client } as any, options as any)) as any
  return { hooks, toasts, logs, sessions }
}

function taskArgs(subagent_type: string, description: unknown = "do it", prompt = "do the thing") {
  return { subagent_type, description, prompt } as {
    subagent_type: string
    description: unknown
    prompt: string
    background?: boolean
  }
}

/** Run tool.execute.before for a dispatch. */
async function dispatch(hooks: any, args: ReturnType<typeof taskArgs>, sessionID = "parent", callID = "call-1") {
  await hooks["tool.execute.before"]({ tool: "task", sessionID, callID }, { args })
  return { args }
}

/** Register a child session the way the task tool would create it. */
function childSession(
  sessions: Map<string, { parentID?: string; title?: string }>,
  id: string,
  agent: string,
  description = "do it",
  parentID = "parent",
) {
  sessions.set(id, { parentID, title: `${description} (@${agent} subagent)` })
}

function childMessage(sessionID: string, text = "do the thing") {
  return {
    message: {
      sessionID,
      role: "user",
      model: { providerID: "original", modelID: "original-model", variant: "default" },
    },
    parts: [{ type: "text", text }],
  } as any
}

describe("configuration", () => {
  test("disables itself when no models are configured", async () => {
    const { hooks, toasts } = await makePlugin({})
    expect(Object.keys(hooks)).toEqual([])
    expect(toasts[0]?.message).toContain("no valid models configured")
  })

  test("skips invalid alias names but keeps valid ones", async () => {
    const { hooks, toasts } = await makePlugin({
      models: [
        { name: "bad alias!", model: "p/m" },
        { name: "good", model: "p/m" },
      ],
    })
    expect(toasts[0]?.message).toContain('"bad alias!" is invalid')
    const output = { description: "Launch a subagent." }
    await hooks["tool.definition"]({ toolID: "task" }, output)
    expect(output.description).toContain("@good")
    expect(output.description).not.toContain("bad alias!")
  })
})

describe("tool.definition", () => {
  test("documents aliases on the task tool only", async () => {
    const { hooks } = await makePlugin()
    const task = { description: "Launch a subagent." }
    await hooks["tool.definition"]({ toolID: "task" }, task)
    expect(task.description).toContain('"@terra" (yourprovider/terra): Deep reasoning.')
    expect(task.description).toContain('"@luna" (openai/gpt-5.5-luna): Fast mechanical tasks.')

    const other = { description: "Read a file." }
    await hooks["tool.definition"]({ toolID: "read" }, other)
    expect(other.description).toBe("Read a file.")
  })
})

describe("tool.execute.before", () => {
  test("appends the full model reference to an aliased task description", async () => {
    const { hooks } = await makePlugin()
    const { args } = await dispatch(hooks, taskArgs("review/security@terra", "Identify running model"))
    expect(args.subagent_type).toBe("review/security")
    expect(args.description).toBe("Identify running model (yourprovider/terra)")
    expect(args.prompt).toBe("do the thing")
  })

  test("uses only the full model reference for an empty aliased description", async () => {
    const { hooks } = await makePlugin()
    const { args } = await dispatch(hooks, taskArgs("review/security@terra", ""))
    expect(args.description).toBe("(yourprovider/terra)")
  })

  test("leaves a default-model task description unchanged", async () => {
    const { hooks } = await makePlugin()
    const { args } = await dispatch(hooks, taskArgs("review/security", "Identify running model"))
    expect(args.description).toBe("Identify running model")
  })

  test("leaves an unknown-alias task description unchanged", async () => {
    const { hooks } = await makePlugin()
    const { args } = await dispatch(hooks, taskArgs("review/security@nope", "Identify running model"))
    expect(args.description).toBe("Identify running model")
  })

  test("leaves a non-string aliased task description unchanged", async () => {
    const { hooks } = await makePlugin()
    const description = { task: "Identify running model" }
    const { args } = await dispatch(hooks, taskArgs("review/security@terra", description))
    expect(args.description).toBe(description)
  })
})

describe("chat.message", () => {
  test("swaps the model for the matching child", async () => {
    const { hooks, sessions } = await makePlugin()
    await dispatch(hooks, taskArgs("review@terra"))
    childSession(sessions, "child", "review", "do it (yourprovider/terra)")

    const output = childMessage("child")
    await hooks["chat.message"]({ sessionID: "child", agent: "review" }, output)
    expect(output.message.model).toEqual({ providerID: "yourprovider", modelID: "terra", variant: undefined })
    expect(output.parts[0].text).toBe("do the thing")
  })

  test("swaps the model when the child title uses the rewritten description", async () => {
    const { hooks, sessions } = await makePlugin()
    await dispatch(hooks, taskArgs("review/security@terra", "Audit auth"))
    childSession(sessions, "child", "review/security", "Audit auth (yourprovider/terra)")

    const output = childMessage("child")
    await hooks["chat.message"]({ sessionID: "child", agent: "review/security" }, output)
    expect(output.message.model.modelID).toBe("terra")
  })

  test("handles model ids containing slashes", async () => {
    const { hooks, sessions } = await makePlugin({
      models: [{ name: "deep", model: "openrouter/vendor/model-x" }],
    })
    await dispatch(hooks, taskArgs("agent@deep"))
    childSession(sessions, "child", "agent", "do it (openrouter/vendor/model-x)")

    const output = childMessage("child")
    await hooks["chat.message"]({ sessionID: "child", agent: "agent" }, output)
    expect(output.message.model.providerID).toBe("openrouter")
    expect(output.message.model.modelID).toBe("vendor/model-x")
  })

  test("no swap for a different parent", async () => {
    const { hooks, sessions } = await makePlugin()
    await dispatch(hooks, taskArgs("review@terra"))
    childSession(sessions, "other-child", "review", "do it", "someone-else")

    const output = childMessage("other-child")
    await hooks["chat.message"]({ sessionID: "other-child", agent: "review" }, output)
    expect(output.message.model.modelID).toBe("original-model")
  })

  test("no swap for a different agent", async () => {
    const { hooks, sessions } = await makePlugin()
    await dispatch(hooks, taskArgs("review@terra"))
    childSession(sessions, "child", "impostor")

    const output = childMessage("child")
    await hooks["chat.message"]({ sessionID: "child", agent: "impostor" }, output)
    expect(output.message.model.modelID).toBe("original-model")
  })

  test("no swap on title mismatch", async () => {
    const { hooks, sessions } = await makePlugin()
    await dispatch(hooks, taskArgs("review@terra", "task one"))
    childSession(sessions, "child", "review", "something else")

    const output = childMessage("child")
    await hooks["chat.message"]({ sessionID: "child", agent: "review" }, output)
    expect(output.message.model.modelID).toBe("original-model")
  })

  test("concurrent dispatches resolve by description, in any order", async () => {
    const { hooks, sessions } = await makePlugin()
    await dispatch(hooks, taskArgs("agent@terra", "task one"), "parent", "call-1")
    await dispatch(hooks, taskArgs("agent@luna", "task two"), "parent", "call-2")
    childSession(sessions, "child-1", "agent", "task one (yourprovider/terra)")
    childSession(sessions, "child-2", "agent", "task two (openai/gpt-5.5-luna)")

    // The second dispatch's child happens to message first.
    const second = childMessage("child-2")
    await hooks["chat.message"]({ sessionID: "child-2", agent: "agent" }, second)
    expect(second.message.model.modelID).toBe("gpt-5.5-luna")

    const first = childMessage("child-1")
    await hooks["chat.message"]({ sessionID: "child-1", agent: "agent" }, first)
    expect(first.message.model.modelID).toBe("terra")
  })

  test("indistinguishable dispatches apply oldest-first with a warning", async () => {
    const { hooks, sessions, toasts } = await makePlugin()
    await dispatch(hooks, taskArgs("agent@terra"), "parent", "call-1")
    await dispatch(hooks, taskArgs("agent@terra"), "parent", "call-2")
    childSession(sessions, "child-a", "agent", "do it (yourprovider/terra)")
    childSession(sessions, "child-b", "agent", "do it (yourprovider/terra)")

    const first = childMessage("child-a")
    await hooks["chat.message"]({ sessionID: "child-a", agent: "agent" }, first)
    expect(first.message.model.modelID).toBe("terra")
    expect(toasts.some((toast) => toast.message.includes("indistinguishable"))).toBe(true)

    const second = childMessage("child-b")
    await hooks["chat.message"]({ sessionID: "child-b", agent: "agent" }, second)
    expect(second.message.model.modelID).toBe("terra")
  })

  test("consumed dispatches don't apply twice", async () => {
    const { hooks, sessions } = await makePlugin()
    await dispatch(hooks, taskArgs("review@terra"))
    childSession(sessions, "child", "review", "do it (yourprovider/terra)")
    childSession(sessions, "lookalike", "review", "do it (yourprovider/terra)")
    await hooks["chat.message"]({ sessionID: "child", agent: "review" }, childMessage("child"))

    const output = childMessage("lookalike")
    await hooks["chat.message"]({ sessionID: "lookalike", agent: "review" }, output)
    expect(output.message.model.modelID).toBe("original-model")
  })

  test("follow-ups stay on the swapped model", async () => {
    const { hooks, sessions } = await makePlugin()
    await dispatch(hooks, taskArgs("review@terra"))
    childSession(sessions, "child", "review", "do it (yourprovider/terra)")
    await hooks["chat.message"]({ sessionID: "child", agent: "review" }, childMessage("child"))

    const followUp = childMessage("child", "resume: continue where you left off")
    await hooks["chat.message"]({ sessionID: "child", agent: "review" }, followUp)
    expect(followUp.message.model.modelID).toBe("terra")

    const unrelated = childMessage("unrelated", "hello")
    await hooks["chat.message"]({ sessionID: "unrelated" }, unrelated)
    expect(unrelated.message.model.modelID).toBe("original-model")
  })
})

describe("tool.execute.after receipt check", () => {
  test("annotates the output when the swap was never applied", async () => {
    const { hooks, toasts } = await makePlugin()
    await dispatch(hooks, taskArgs("review@terra"))
    const output = { metadata: { sessionId: "child" }, output: "task result" }
    await hooks["tool.execute.after"]({ tool: "task", sessionID: "parent", callID: "call-1" }, output)
    expect(output.output).toContain("WARNING")
    expect(output.output).toContain("task result")
    expect(toasts.some((toast) => toast.variant === "warning")).toBe(true)
  })

  test("leaves the output alone when the swap was applied", async () => {
    const { hooks, sessions } = await makePlugin()
    await dispatch(hooks, taskArgs("review@terra"))
    childSession(sessions, "child", "review", "do it (yourprovider/terra)")
    await hooks["chat.message"]({ sessionID: "child", agent: "review" }, childMessage("child"))

    const output = { metadata: { sessionId: "child" }, output: "task result" }
    await hooks["tool.execute.after"]({ tool: "task", sessionID: "parent", callID: "call-1" }, output)
    expect(output.output).toBe("task result")
  })

  test("no warning when a resume already runs the requested model", async () => {
    const { hooks, sessions } = await makePlugin()
    await dispatch(hooks, taskArgs("review@terra"), "parent", "call-1")
    childSession(sessions, "child", "review", "do it (yourprovider/terra)")
    await hooks["chat.message"]({ sessionID: "child", agent: "review" }, childMessage("child"))
    await hooks["tool.execute.after"](
      { tool: "task", sessionID: "parent", callID: "call-1" },
      { metadata: { sessionId: "child" }, output: "done" },
    )

    // Resume with the same alias but a new description: no title match, but the
    // session is sticky on the requested model, so the run was correct.
    await dispatch(hooks, taskArgs("review@terra", "follow-up work"), "parent", "call-2")
    const followUp = childMessage("child", "continue")
    await hooks["chat.message"]({ sessionID: "child", agent: "review" }, followUp)
    expect(followUp.message.model.modelID).toBe("terra")

    const output = { metadata: { sessionId: "child" }, output: "task result" }
    await hooks["tool.execute.after"]({ tool: "task", sessionID: "parent", callID: "call-2" }, output)
    expect(output.output).toBe("task result")
  })

  test("keeps background dispatches pending for a late first message", async () => {
    const { hooks, sessions } = await makePlugin()
    const args = { ...taskArgs("review@terra"), background: true }
    await dispatch(hooks, args)

    // Background tasks return (and fire the after hook) immediately.
    const output = { metadata: { sessionId: "child" }, output: "task result" }
    await hooks["tool.execute.after"]({ tool: "task", sessionID: "parent", callID: "call-1" }, output)
    expect(output.output).toBe("task result")

    // The child's first message arrives afterwards and still swaps.
    childSession(sessions, "child", "review", "do it (yourprovider/terra)")
    const message = childMessage("child")
    await hooks["chat.message"]({ sessionID: "child", agent: "review" }, message)
    expect(message.message.model.modelID).toBe("terra")
  })

  test("ignores dispatches it did not tag", async () => {
    const { hooks } = await makePlugin()
    await dispatch(hooks, taskArgs("review/security"))
    const output = { metadata: { sessionId: "child" }, output: "task result" }
    await hooks["tool.execute.after"]({ tool: "task", sessionID: "parent", callID: "call-1" }, output)
    expect(output.output).toBe("task result")
  })
})
