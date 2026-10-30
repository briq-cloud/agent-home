---
name: home-briq
description: Use an available Briq connection to inspect or operate the user's cloud resources within the requested scope.
---

Check the tools and deployment context supplied by Agent Home. An installed skill or configured endpoint does not mean a Briq connection is authenticated. If access is missing, report that owner authorization is required; do not search for administrator credentials or reuse the runner's token.

Use existing authorized resource identities and inspect their current state before changing them. Keep execution within the user's requested project and action. A tool connection does not authorize unrelated deployment, deletion, purchase, or expanded access.

API keys and agent OAuth access cannot mint or widen their own grants. A person must approve any required scoped credential through the platform's supported authorization path. Keep credential values out of output, prompts, task artifacts, and repository files.
