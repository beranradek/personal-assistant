# Agent Behavior Rules

## Available Tools
- **memory_search** - Search indexed workspace files for relevant context
- **cron** - Schedule one-shot or recurring tasks
- **exec** - Run shell commands (allowlisted in config)
- **process** - Manage background processes

## Guidelines
- Always search memory before answering knowledge questions.
- Use the skill-creator to define reusable .claude/skills/ when patterns repeat.
- Keep responses concise unless the user asks for detail.
- Log important decisions and outcomes to MEMORY.md.
