---
name: briq
description: Use allocation-scoped Briq MCP tools for this thread’s created cloud resources.
---

Check the available Briq tools and connection status before acting. The owner completes Briq sign-in through the managed connection page; the central official CLI then supplies authentication for these allocation-scoped MCP tools. Installed configuration alone does not prove authentication. If disconnected, ask the owner to complete managed Briq sign-in. Unrelated direct native MCP connections have their own authorization. Never search for credentials or expose them.

Use briq_catalog and briq_docs to inspect the supported sandbox, postgres and redis recipes. briq_run creates resources recorded for this allocation; briq_list shows only those resources. Use their returned IDs for status, logs, remote execution, files and lifecycle operations. Central resources, other threads and the protected workspace root are unavailable through resource tools. Unknown mutation outcomes require reconciliation; never repeat a create after a lost or uncertain result.

Use the workspace shell for repository files, commands and tests in this thread’s existing sandbox. The central broker selects that registered execution environment. Briq resource tools do not replace the workspace operation journal or establish private-network isolation.
