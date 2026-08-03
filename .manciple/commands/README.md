# Manciple Commands

This directory holds command reference files and local workflow notes.

## Usage

Run `manciple --help` to see all available commands.

## Workflow

```bash
manciple task new "My task title" --type implementation --domain core --priority high
manciple validate
manciple handoff my-task-title
# Run the generated prompt in your preferred coding agent
manciple run-log my-task-title
manciple set-status my-task-title needs_review
manciple review my-task-title
```
