==========================================================
  PROJECT SELF-MANAGEMENT
==========================================================

A private web app version of your "Project Self-Management Advanced"
workbook. Your 11 projects and their tasks are already loaded in.

WHAT'S HERE
  index.html          The whole app (one file). Open online after setup.
  SETUP.txt           One-time setup: Google sign-in + database + hosting.
  SECURITY.md         The security policy (plain language + honest caveats).
  instant.schema.ts   Data model (only needed for the CLI setup path).
  instant.perms.ts    Server permission rules (only for the CLI path).

FEATURES
  • Projects — Board (drag between Not Started / In Progress / On Hold / Done)
    and List views. Search + filter by priority/category.
  • Click any project → side panel with description, stakeholders, doc link,
    value proposition, last-discussed, next steps, and a task checklist.
  • Calendar — projects shown on their deadline dates, coloured by priority.
  • Year — 52-week overview with the current week highlighted.
  • Light / dark theme (sun/moon icon).
  • Security panel (shield icon) — approve/revoke devices, sign out others,
    activity log.

HOW ACCESS WORKS
  • Only  keremladkeholland@gmail.com  can sign in (Google), enforced on the
    server so it can't be bypassed.
  • New devices must be approved from a device you already trust. The first
    device is trusted automatically.
  • See SECURITY.md for the full policy.

TO GO LIVE
  Follow SETUP.txt. Until you paste in a Google Client ID and host it, the app
  opens in "local only" mode so you can look around, but nothing syncs or is
  protected. Google sign-in requires a real https:// address (hosting).

UPDATING LATER
  Edit index.html (or ask Claude), then re-upload it to your GitHub repo.
  GitHub Pages refreshes within ~1 minute.
==========================================================
