---
description: Show, switch off or on, or roll back the filters TokenWise learned
disable-model-invocation: true
argument-hint: "[off | on | rollback]"
allowed-tools: Bash(tokenwise rules:*)
---
Run exactly one of these commands with the Bash tool, and nothing else:

- `tokenwise rules off`, `tokenwise rules on` or `tokenwise rules rollback` if the user asked for that
- `tokenwise rules` otherwise

What the user typed after the command: $ARGUMENTS

Then tell the user what it printed, briefly and in their language.
