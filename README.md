# subagent-model-alias

[opencode](https://opencode.ai) plugin that lets the main agent run any subagent on a different model by appending `@alias` to `subagent_type` in the native task tool:

```
task(subagent_type: "review/security@terra", ...)
```

Aliases map to an allow-list of models in your config, so there's no need for custom tools or per-agent variants.

## How it works

Four hooks around a normal task dispatch:

- `tool.definition` — adds the `@alias` convention and your per-model guidance to the task tool description.
- `tool.execute.before` — strips the suffix so the real agent resolves, annotates the task description with the full configured model reference (for example, `Audit auth (openai/gpt-5.6-terra)`), and records the dispatch (parent session, agent, expected child session title, model) in plugin memory. This visible annotation persists in the parent task history.
- `chat.message` — matches the child session's first message against a recorded dispatch (direct child of the dispatching session, expected agent and title) and rewrites the message's model before it is saved — the same mechanism `/model` uses. Follow-up messages stay on the swapped model.
- `tool.execute.after` — if the swap never happened, appends a warning to the task output.

Because this rides an ordinary task dispatch, everything native keeps working: same-turn results, the task permission ask, `task_id` resume, background mode, child permissions.

## Install

Clone this repository:

```sh
git clone https://github.com/<you>/subagent-model-alias
```

Register the folder path with options in `opencode.json` (relative paths resolve from the config file):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    ["./subagent-model-alias", {
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

## Options

| Option | Type | Description |
|---|---|---|
| `models` | array | **Required.** Allow-list of models the agent may dispatch on. The plugin disables itself (with an error toast) if empty. |
| `models[].name` | string | The `@alias`. Letters, digits, `-`, `_` only. |
| `models[].model` | string | Full model reference, `provider/model-id`. Not validated by the plugin; a bad reference fails in opencode's provider resolution. |
| `models[].when` | string | Routing guidance shown in the task tool description. Optional, but without it the agent has no basis for choosing. |

## Caveats

- Relies on opencode internals: `chat.message` firing before the child's first message is saved, child sessions being titled `"<description> (@<agent> subagent)"`, and `subagent_type` matching the agent's registry name. If any of that changes, the task runs on the default model and the output gets a warning.
- Two concurrent dispatches with the same parent, agent, *and* description can't be told apart; they're applied oldest-first with a warning toast. Distinct descriptions are unambiguous.
- Re-aliasing a `task_id` resume only applies when the call's `description` matches the child's original title; otherwise the session keeps its sticky model (quiet if that's already the requested model, warned otherwise).
- The TUI header may briefly show the original model; the saved messages and all actual LLM calls use the swapped one.
- State is in-memory. Nothing survives a restart; a resumed child falls back to the default model afterwards.
- Swapping clears the message's model variant (a variant valid on the original model may not exist on the target).

## Compatibility

Don't run this alongside another plugin that also consumes an `@alias` suffix on the task tool's `subagent_type`; the first plugin to strip it wins.
