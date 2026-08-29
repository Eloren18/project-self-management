==========================================================
  PROJECT SELF-MANAGEMENT
==========================================================

A private, single-file web app: a Work platform (projects, tasks,
meetings, glossary, documents) and a Personal Life platform (days,
journal, focus, bucket list, people, detox) behind one switch.

Live at:  https://eloren18.github.io/project-self-management/

WHAT'S HERE
  index.html          The whole frontend (one file, no build step).
  convex/             The backend (database + sign-in), hosted on Convex.
  tests/              End-to-end sync & data-safety test suite.
  FEATURES.md         The complete feature inventory + full-check protocol.
  SECURITY.md         The security policy (plain language + honest caveats).
  SETUP-Convex.txt    Hosting, backend, and update instructions.
  ARCHITECTURE_NOTES.md  Design notes for the Personal platform.

HOW ACCESS WORKS
  • Only keremladkeholland@gmail.com can sign in — you get a 6-digit
    code by email (Resend), enforced on the server so it can't be bypassed.
  • New devices must be approved from a device you already trust. The
    first device is trusted automatically. The server refuses data
    requests from unapproved devices.
  • See SECURITY.md for the full policy.

UPDATING
  Frontend: edit index.html, run Deploy.bat (GitHub Pages refreshes in
  ~1 minute). Backend: edit convex/, run Deploy-Backend.bat.
  Before shipping: node tests/e2e-sync.mjs must be all green.
==========================================================
