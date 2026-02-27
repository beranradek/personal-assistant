# Personal Assistant 

## Basic laws - MUST have security features 

Security sandbox allowing to edit and read files only from the directory where the personal assistant is executed.

Must include a whitelist of allowed bash commands. Change directory command is NOT allowed by default.

Must include PreTool hook for bash commands that checks if the command is executed within the allowed directory or subdirectory of allowed directory.

Optionally, other directories to read from and directories to write into can be allowed.

Personal Assistant cannot change its own source codes or installation.

## Memory for Personal Assistant

Agent will remember your decisions, preferences and context.

Markdown files
AGENTS.md - agent behavior - basic instructions and rules for personal assistant
SOUL.md - agent identity - personality and values
USER.md - who the user is and preferences of the user
MEMORY.md - long-term memory - decisions, lessons learned 
HEARTBEAT.md - what to check and how to process events and notify user
Daily session logs in daily/ directory in assistant's working directory 
SQLite-vec for lightweight RAG

AGENTS.md, SOUL.md, USER.md and MEMORY.md should be concatenated and appended to system message within Claude Agents SDK, so these instructions have appropriate importance and also are cached within the requests to Anthropic API which is very important to spare costs. Confirm this is a good approach, also by investigating OpenClaw’s code.

Implement Hybrid Search (0.7 x vector + 0.3 x keyword (BM25)) with SQLite + FastEmbed (384-dim, ONNX), fully local - no API calls.

## Adapters for Personal Assistant 

User can communicate with the Personal Assistant using:

Terminal - for direct interaction 
Telegram - private (non-public) webhook 
Slack (socket mode) - no public URL needed; conversations available at app.slack.com/client/…/…; each thread is persistent conversation 

## Heartbeat functionality 

Agent can act on user's behalf if the user wants to, anticipate what you need. Knows you better every day.

Agent is invoked based on cron schedule - by default every configured X minute (30 minutes by default - configurable in settings), so this makes feel like it is constantly running. This way he is invoked without a user prompt, but with an automatically constructed message on what to check (“Look at the memory and the events from …”). The application code (not the agent directly so this doesn't cost many tokens) will check all the integrated services for new events (from the last invocation time) and make the events received available to the agent so he can decide to send notification to the user if there is something important to solve, or not to send anything if there is nothing important so the user is not spammed with notifications.

Example notification: “Meeting in 15 minutes. The prepared doc is empty.”

This should be checked thoroughly in OpenClaw’s code as reference implementation and implemented the best possible way.

## Skills 

Agent can use the local .claude/skills that will be present in the directory where he is executed, local standard for Claude Code and his SDK. This directory will be used in settings for Claude Agents SDK. No other directories with unverified skills.

Agent will be instructed so he can use skill-creator meta skill to create his own skills in his directory when needed after very useful lessons learned, or when instructed by user.

## Application configuration 

Whitelisted bash commands, directories allowed to read and to write can be managed by the user in application configuration settings.json.

Read, Write, Edit, Glob, Grep, Bash, WebFetch, WebSearch tools are allowed. Bash commands controlled by PreTool hook - check for allowance before the tool call.

This file will have also mcpServers section with standard configuration of MCP servers that are allowed to be used. These MCP servers will be passed/allowed to Claude Agents SDK.

## Prerequisites required 

Installed Claude Code CLI authenticated via login command to user's subscription or with API key configured (or another Anthropic API and Claude Agents SDK compatible agent).
 
##  Technologies 

Typescript programming language.

Technically a secure, sandboxed clone of OpenClaw personal assistant with just a subset of useful features. OpenClaw is also written in Typescript.

Claude Agents SDK for Typescript - allows users to use their monthly Claude subscription or API key.

Obsidian to easily edit and share markdown files for assistant’s memory.

## Documentation of application 

Document shortly agent capabilities,how to install and configure it and run it 
through terminal and Telegram.

## References for implementation

- OpenClaw source codes: /home/radek/dev/openclaw - MUST analyze and reuse/update/simplify appropriate parts of it
- https://platform.claude.com/docs/en/agent-sdk/overview, https://platform.claude.com/docs/en/agent-sdk/typescript - Claude Agents SDK documentation - MUST READ
- feat/01-core-implementation/examples/client.py - example Claude Agents SDK usage from other (Python) project (but we will use TypeScript/node) - MUST READ
- feat/01-core-implementation/examples/security.py - example of security sandbox implementation for Claude Agents SDK - MUST READ

—-

Copy and use appropriate parts of the OpenClaw project that is under MIT license and update them to align with my architectural decisions. Clear the unnecessary parts of the code if not useful and not used for my personal assistant implementation. Use Open Claw as your blueprint, not as dependency. Keep the implementation simple, reliable and secure, using best-in-class programming practices and most up-to-date libraries.

First investigate how memory system, heartbeat, adapters and skills in OpenClaw works, run separate agents for researches in these areas to create separate analysis files on these topics that includes also references to source code files and key signatures of source code components and store the analysis files as markdown files within feat/01-core-implementation directory. Spawn also another research agent for security implementation analysis and store this analysis as well. Then read and understand these analysis files deeply, do another research how these parts work together and create comprehensive implementation plan for my personal assistant that you store to the same directory.

You are building the project from the scratch.
