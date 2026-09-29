---
name: subagent-model-alias-smoke-test
description: Verify that configured subagent model aliases route to their expected models.
---

# Subagent model alias smoke test

Use this skill only as an opt-in runtime verification after the alias-routing plugin is loaded.

1. Read the currently configured aliases and their expected `provider/model-id` values from the plugin-augmented documentation for the native `task` tool. Do not infer aliases from local files, and do not assume or hard-code alias names or model IDs. If no configuration can be found, stop immediately and report to the user.
2. For every discovered alias, select a native subagent type named in the native `task` tool documentation and dispatch exactly one minimal child through the native `task` tool. Set its `subagent_type` to `<native-subagent-type>@<alias>`, substituting the selected native type and discovered alias, and give it this instruction verbatim in substance: return only the effective model ID, with no explanation, punctuation, or code formatting.
3. Treat each child's response as its actual effective model ID and compare it with that alias's expected `provider/model-id`.
4. Report one explicit `PASS` or `FAIL` for every alias, including the expected and actual model IDs. Report an overall `PASS` only when every alias passes; otherwise report an overall `FAIL`.
5. If any actual model differs from the expected model, include an explicit plugin swap warning naming the affected alias and both model IDs. Do not silently treat a swap as a pass.

Do not dispatch any child that is not one of the discovered aliases, and do not dispatch more than one child per alias. Only try to dispatch subagents once, do not retry on error, stop and report the error to the user.
