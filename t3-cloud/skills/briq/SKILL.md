---
name: briq
description: Use an authenticated Briq MCP connection or native CLI to work with authorized cloud resources.
---

Check the available Briq tools and authentication before acting. Installed configuration is not an authenticated connection. Briq CLI login and MCP authorization are separate. Ask the owner to complete the supported sign-in or provide an authorized scoped MCP credential if disconnected. Never search for credentials or expose them.

Inspect existing resource identities before changing them and stay within the requested scope. Use Briq sandboxes when the user requests remote execution. This skill does not redirect the provider's native shell or enforce a fresh sandbox for each T3 thread: native tools run on the T3 server's environment.
