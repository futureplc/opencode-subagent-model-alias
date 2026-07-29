# subagent-model-alias

**Per-dispatch model selection for [opencode](https://opencode.ai)'s native task tool** - opencode pins a model per agent (the `model` field in agent config), so the caller cannot choose a model per dispatch, only per agent definition. `subagent-model-alias` gives the caller that choice back, without a custom tool or a second copy of the agent per model:

```text
task(subagent_type: "review/security@terra", ...)
```

Appending `@<alias>` to `subagent_type` runs that one dispatch on the aliased model instead of the agent's configured default. One agent definition, many models, chosen per call from an allow-list you control in `opencode.json`, with no custom tools and no per-model agent variants.

## How It Works

Four hooks around an ordinary task dispatch:

1. `tool.definition` adds the `@alias` convention and your per-model guidance to the task tool's description, so the dispatching agent sees the available aliases and when to use them.
2. `tool.execute.before` strips the `@alias` suffix so the real agent resolves normally, annotates the task description with the full configured model reference (for example, `Audit auth (openai/gpt-5.6-terra)`), and records the dispatch (parent session, agent, expected child session title, model) in plugin memory.
3. `chat.message` matches the child session's first message against a recorded dispatch (direct child of the dispatching session, expected agent and title) and rewrites the message's model before it is saved. Follow-up messages on that session stay on the swapped model.
4. `tool.execute.after` checks whether the recorded dispatch was consumed. If the swap never happened, it appends a warning to the task output.

Because this rides an ordinary task dispatch, everything native keeps working: same-turn results, the task permission ask, `task_id` resume, background mode, child permissions.

### What You See

Recorded task calls in your history show the bare `subagent_type`: the suffix is consumed during dispatch, so a missing `@alias` in your history means it was applied, not ignored. The task description carries the visible receipt instead, annotated with the full model reference, for example `Audit auth (openai/gpt-5.6-terra)`, and this annotation persists in the parent task history.

If a swap never happens, the child runs on the default model and the task tool's output is prefixed with a warning telling you to report it to the user and not assume the requested model ran.

## Why Hook the Native Task Tool

> Model selection could have been a custom tool instead. Wrapping the native task tool means every native task-tool behaviour (same-turn results, the permission ask, `task_id` resume, background mode, child permissions) keeps working with zero reimplementation. The only mechanism this plugin adds is the `chat.message` rewrite that swaps the child's model before its first message is saved. Everything else stays opencode's own task machinery, unmodified.

## Install

Clone the repository:

```sh
git clone https://github.com/Iris314/opencode-subagent-model-alias
```

```text
opencode-subagent-model-alias/
├── src/
│   └── index.ts          # plugin entry, single file
├── test/
│   └── index.test.ts     # bun:test suite
├── package.json
└── README.md
```

Register the folder path with options in `opencode.json` (relative paths resolve from the config file):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    ["./opencode-subagent-model-alias", {
      "models": [
        {
          "name": "terra",
          "model": "openai/gpt-5.6-terra",
          "when": "Deep reasoning, complex analysis, security-sensitive reviews."
        },
        {
          "name": "luna",
          "model": "openai/gpt-5.6-luna",
          "when": "Fast mechanical tasks: renames, sweeps, formatting, lookups."
        }
      ]
    }]
  ]
}
```

> [!IMPORTANT]
> Register the plugin only via this config entry. Don't also copy `src/index.ts` into an auto-discovery directory (`plugin/` next to your config): auto-discovered plugins load without options, and you'd end up with a second, non-functional instance.

Requires opencode `>=1.17.18` (the `engines.opencode` floor in `package.json`). Runtime dependencies are `@opencode-ai/plugin` and `@opencode-ai/sdk`, both pinned to `^1.17.18`.

## Options

| Option           | Type   | Description                                                                                                                      |
|------------------|--------|----------------------------------------------------------------------------------------------------------------------------------|
| `models`         | array  | **Required.** Allow-list of models the agent may dispatch on. The plugin disables itself (with an error toast) if empty.         |
| `models[].name`  | string | The `@alias`. Must start with a letter or digit; remaining characters may be letters, digits, `-` or `_`.                        |
| `models[].model` | string | Full model reference, `provider/model-id`. Not validated by the plugin; a bad reference fails in opencode's provider resolution. |
| `models[].when`  | string | Routing guidance shown in the task tool description. Optional, but without it the agent has no basis for choosing.               |

With the two aliases configured above, the dispatching agent can call:

```text
task(subagent_type: "review/security@terra", description: "Audit auth", prompt: "...")
```

This runs `review/security` on `openai/gpt-5.6-terra`, and the recorded task description becomes `Audit auth (openai/gpt-5.6-terra)`.

## Choosing Aliases

Write `when` guidance the agent can act on without you in the loop: name the task property that justifies the model, not a vibe. "Deep reasoning, complex analysis, security-sensitive reviews" gives the agent a basis for reaching for `@terra`; "the good model" does not. The same applies in the other direction: naming concrete task categories such as renames, sweeps, formatting or lookups steers the agent towards a cheaper or faster alias instead.

Reach for a per-agent `model` in agent config instead of an alias when every dispatch to that agent should always run on the same model. Aliases exist for the opposite case: one agent, several models, chosen per call. If an alias's `when` guidance would apply to every dispatch of that agent, that is a sign the agent's own `model` field is the better fit, not an alias.

## Tests

```sh
bun test
bun run typecheck
```

`bun test` runs `test/index.test.ts` against a harness that stubs the three client calls the plugin makes (`client.tui.showToast`, `client.app.log`, `client.session.get`) plus an in-memory session table to control parentage and titles, exercising every hook for real. 

Coverage includes: invalid and empty alias configuration; `tool.definition` scoping to the task tool only; description annotation for aliased, default, unknown-alias and non-string-description dispatches; model swapping including multi-slash model ids; no-swap cases for a different parent, a different agent and a title mismatch; concurrent and indistinguishable dispatches; consumed dispatches not reapplying; follow-up messages staying on the swapped model; and the `tool.execute.after` receipt check, including the background-dispatch and already-sticky-resume paths.

`bun run typecheck` runs `tsc --noEmit` against `src` and `test`.

## Known Limitations

**Relies on opencode internals.** `chat.message` firing before the child's first message is saved, child sessions being titled `"<description> (@<agent> subagent)"`, and `subagent_type` matching the agent's registry name. If any of that changes, the task runs on the default model and the output gets a warning.

**Same-parent, same-agent, same-description dispatches are indistinguishable.** Two concurrent dispatches with the same parent, agent, and description can't be told apart; they're applied oldest-first with a warning toast. Distinct descriptions are unambiguous.

**Resume matching is title-based.** Re-aliasing a `task_id` resume only applies when the call's `description` matches the child's original title; otherwise the session keeps its sticky model (quiet if that's already the requested model, warned otherwise).

**The TUI header can lag.** It may briefly show the original model; the saved messages and all actual LLM calls use the swapped one.

**State is in-memory.** Nothing survives a restart; a resumed child falls back to the default model afterwards. Sticky sessions are LRU-bounded at 500 entries, so a follow-up to an evicted session silently loses its swapped model too.

**Swapping clears the message's model variant.** A variant valid on the original model may not exist on the target.

**Don't stack `@alias` plugins.** Running this alongside another plugin that also consumes an `@alias` suffix on the task tool's `subagent_type` isn't supported; the first plugin to strip it wins.
