---
name: GitHub Actions API access
description: Distinguishes repository Git access from authenticated GitHub Actions API access in this workspace.
---

Git push through Replit's secure GitHub proxy can succeed while GitHub CLI workflow dispatch to github.com returns HTTP 401. Unauthenticated REST requests can still read public workflow status.

**Why:** A normal push to the connected `main` branch succeeded, but manual workflow dispatch required GitHub API authentication that was not available in the workspace.

**How to apply:** Do not infer Actions dispatch access from a working Git remote. When manual dispatch is needed, use an authorized GitHub UI or integration; otherwise observe scheduled runs. Never request API credentials in chat.
