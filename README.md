# subagent-model-alias

**Per-dispatch model selection for [opencode](https://opencode.ai)'s native task tool** - opencode pins a model per agent (the `model` field in agent config), so the caller cannot choose a model per dispatch, only per agent definition. `subagent-model-alias` gives the caller that choice back, without a custom tool or a second copy of the agent per model:

```text
task(subagent_type: "review/security@terra", ...)
```

Appending `@<alias>` to `subagent_type` runs that one dispatch on the aliased model instead of the agent's configured default. One agent definition, many models, chosen per call from an allow-list you control in `opencode.json`, with no custom tools and no per-model agent variants.

## How It Works

Four hooks around an ordinary task dispatch:

1. `tool.definition` adds the `@alias` convention and your per-model guidance to the task tool's description, so the dispatching agent sees the available aliases and when to use them.
2. `tool.execute.before` strips the `@alias` suffix so the real agent resolves normally, annotates the task description with the configured model and variant if present (for example, `Audit auth (openai/gpt-5.6-terra, medium)`), and records the dispatch (parent session, agent, expected child session title, optional resumed session ID, model) in plugin memory.
3. `chat.message` matches a new child session against a recorded dispatch by parent, agent, and title. An aliased `task_id` resume instead matches that exact child session, while retaining the parent and agent checks. It rewrites the message's model and configured variant before it is saved. Follow-up messages on that session stay on the swapped model.
4. `tool.execute.after` checks whether the recorded dispatch was consumed. If the swap never happened, it appends a warning to the task output.

Because this rides an ordinary task dispatch, everything native keeps working: same-turn results, the task permission ask, `task_id` resume, background mode, child permissions.

### What You See

Recorded task calls in your history show the bare `subagent_type`: the suffix is consumed during dispatch, so a missing `@alias` in your history means it was applied, not ignored. The task description carries the visible receipt instead, annotated with the configured model and variant, for example `Audit auth (openai/gpt-5.6-terra, medium)`, and this annotation persists in the parent task history.

If a swap never happens, the task tool's output says whether it continued on its prior session selection (when sticky state exists) or used its normal/default selection (when it does not), and tells you not to assume the requested model ran.

## Why Hook the Native Task Tool

> Model selection could have been a custom tool instead. Wrapping the native task tool means every native task-tool behaviour (same-turn results, the permission ask, `task_id` resume, background mode, child permissions) keeps working with zero reimplementation. The only mechanism this plugin adds is the `chat.message` rewrite that swaps the child's model before its first message is saved. Everything else stays opencode's own task machinery, unmodified.

## Install

Clone the repository:

```sh
git clone https://github.com/futureplc/opencode-subagent-model-alias
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
          "variant": "medium",
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
| `models[].variant` | string | Optional exact model variant for this alias. If omitted, the plugin clears the original message's variant. |
| `models[].when`  | string | Routing guidance shown in the task tool description. Optional, but without it the agent has no basis for choosing.               |

With the two aliases configured above, the dispatching agent can call:

```text
task(subagent_type: "review/security@terra", description: "Audit auth", prompt: "...")
```

This runs `review/security` on `openai/gpt-5.6-terra` with the `medium` variant, and the recorded task description becomes `Audit auth (openai/gpt-5.6-terra, medium)`. If an alias omits `variant`, the plugin sets the child message's variant to `undefined`, clearing any variant selected for the original model and displaying only the model on the description.

## Choosing Aliases

Write `when` guidance the agent can act on without you in the loop: name the task property that justifies the model, not a vibe. "Deep reasoning, complex analysis, security-sensitive reviews" gives the agent a basis for reaching for `@terra`; "the good model" does not. The same applies in the other direction: naming concrete task categories such as renames, sweeps, formatting or lookups steers the agent towards a cheaper or faster alias instead.

Reach for a per-agent `model` in agent config instead of an alias when every dispatch to that agent should always run on the same model. Aliases exist for the opposite case: one agent, several models, chosen per call. If an alias's `when` guidance would apply to every dispatch of that agent, that is a sign the agent's own `model` field is the better fit, not an alias.

## Tests

```sh
bun test
bun run typecheck
```

`bun test` runs `test/index.test.ts` against a harness that stubs the three client calls the plugin makes (`client.tui.showToast`, `client.app.log`, `client.session.get`) plus an in-memory session table to control parentage and titles, exercising every hook for real. 

Coverage includes: invalid and empty alias configuration; `tool.definition` scoping to the task tool only; description annotation for aliased, default, unknown-alias and non-string-description dispatches; model swapping, configured variants, omitted-variant clearing, and multi-slash model ids; direct `task_id` resume matching; no-swap cases for a different parent, a different agent and a title mismatch; concurrent and indistinguishable dispatches; consumed dispatches not reapplying; follow-up messages staying on the swapped model; and the `tool.execute.after` receipt check, including the background-dispatch and sticky-resume paths.

`bun run typecheck` runs `tsc --noEmit` against `src` and `test`.

## Known Limitations

**Relies on opencode internals.** `chat.message` firing before the child's first message is saved, child sessions being titled `"<description> (@<agent> subagent)"`, and `subagent_type` matching the agent's registry name. If any of that changes, the task runs on the default model and the output gets a warning.

**Same-parent, same-agent, same-description dispatches are indistinguishable.** Two concurrent dispatches with the same parent, agent, and description can't be told apart; they're applied oldest-first with a warning toast. Distinct descriptions are unambiguous.

**Aliased `task_id` resumes are matched directly.** Direct `task_id` resume matching requires the exact child session ID, original parent, resolved agent, and the child title suffix `(@<agent> subagent)`. Re-aliasing a resume reapplies the selected alias's model and variant to that exact child session even when the new description differs. The resume still must originate from the original parent and resolve to the original agent.

**The TUI header can lag.** It may briefly show the original model; the saved messages and all actual LLM calls use the swapped one.

**State is in-memory.** Nothing survives a restart; a resumed child falls back to the default model afterwards. Sticky sessions are LRU-bounded at 500 entries, so a follow-up to an evicted session silently loses its swapped model too.

**Variants must be configured per alias.** `models[].variant` is assigned exactly when present. When it is omitted, swapping clears the message's original variant because it may not exist on the target model.

**Don't stack `@alias` plugins.** Running this alongside another plugin that also consumes an `@alias` suffix on the task tool's `subagent_type` isn't supported; the first plugin to strip it wins.
