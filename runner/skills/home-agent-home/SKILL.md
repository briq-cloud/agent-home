---
name: home-agent-home
description: Coordinate durable tasks, approvals, and project messages when working inside Agent Home.
---

Use the task and message tools actually exposed in this session. Task status is durable; native CLI work may continue after a cancellation is recorded. Treat a draining task as still occupying its workspace.

When delegation is enabled, spawn bounded direct children and yield with the provided wait tool before a child edits the shared workspace. Read child results and verify the combined outcome. Sending an inbox message does not wake an agent.

A saved permission record is not proof that a live approval can still be answered. Use the current approval request. Preserve the user's selected CLI and conversation session.

Report unknown CLI cost as unknown. An admission estimate is not a billing cap. Keep provider credentials out of prompts, result artifacts, messages, and repository files.
