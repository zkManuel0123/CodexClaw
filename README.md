# CodexClaw

> Coding-first AI assistant fork focused on internal Codex orchestration and Telegram topic-based parallel task execution.

CodexClaw is my personal coding-first fork of OpenClaw.

This fork focuses on one product direction: a single assistant that can orchestrate Codex for repository analysis, code edits, reviews, and long-running background tasks without forcing the user to switch into a separate coding bot or legacy slash-command mode.

Pinned summary:

- one assistant surface
- natural-language coding requests
- topic-scoped parallel Codex jobs
- async results routed back to the original Telegram thread

## Positioning

CodexClaw is not trying to preserve all of upstream OpenClaw's product framing.

It is a narrower fork centered on:

- coding-task orchestration
- Telegram topic-based task lanes
- background Codex execution
- async completion delivery back to the originating chat
- a cleaner one-assistant UX

## What Is Different In This Fork

- Codex is treated as an internal tool rather than a separate user-facing mode.
- Legacy `/codex` and `/delegate` paths are de-emphasized for normal use.
- Telegram forum topics can act as isolated lanes for parallel background coding work.
- Finished Codex jobs can route results back to the original Telegram topic automatically.
- The assistant can summarize and coordinate work across multiple running tasks.

## Core Workflow

```text
User message
    |
    v
CodexClaw assistant
    |
    v
internal codex tool
    |
    v
repo inspect / edit / review / background run
    |
    v
result pushed back to the original chat or topic
```

## Why This Fork Exists

The upstream codebase is broad and powerful, but my interest in it is specifically the coding-assistant layer.

I want the interaction model to feel like this:

- one assistant surface
- natural-language coding requests
- many background tasks
- explicit task coordination across chats or topics

That is the main reason for this fork.

## Current Focus Areas

- internal Codex orchestration
- session-scoped and topic-scoped task concurrency
- Telegram completion routing
- coding-oriented prompt and command cleanup
- documentation for practical Telegram usage

## Local Run

Requirements:

- Node 22+
- pnpm

Run locally:

```bash
pnpm install
pnpm openclaw gateway
```

If dashboard auth is missing or expired:

```bash
pnpm openclaw dashboard
```

## Repository Status

- This repository currently keeps the upstream OpenClaw git history.
- Because that history is preserved, GitHub still shows the original upstream contributors in the contributors graph.
- The codebase is still structurally based on OpenClaw, but the product direction of this fork is being shifted toward CodexClaw.

## Upstream Attribution

CodexClaw is currently built on top of the OpenClaw codebase.

- Upstream: https://github.com/openclaw/openclaw
- License: MIT

This fork keeps upstream attribution and license obligations while evolving the product in a different direction.

## Roadmap

- Rebrand user-facing surfaces from OpenClaw to CodexClaw
- Continue simplifying the coding UX around the internal Codex path
- Improve cross-topic status reporting and coordination
- Separate personal-fork docs from upstream-oriented docs
- Decide later whether to keep or rewrite inherited git history
