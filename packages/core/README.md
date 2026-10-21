# packages/core

Business logic shared by the web app, the API and the admin app:
- workspaces, roles, invites, API keys and the audit log
- sources, ideas (scoring and freshness) and Passions
- writing posts, images and video plans
- automation, scheduling and publishing, with the platform adapters
- plans, credits, billing, and AI and platform cost tracking
- admin reports (costs, publishing health, billing, abuse)

Functions take the database as their first argument and a workspace id wherever data belongs to a workspace.
