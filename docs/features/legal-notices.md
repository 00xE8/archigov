# Legal notices and the source offer

## What it does

The app shows every user, signed in or not, the notices the AGPL-3.0 asks of an interactive program, and offers the
source of the very build they are using:

- the version, and the copyright: Skygge Ltd and contributors;
- the licences: AGPL-3.0 for the core, Apache-2.0 for the packs, templates, connectors and importers;
- that there is no warranty;
- a link to the source of this version (AGPL-3.0 §13: whoever uses it over a network is entitled to it);
- the trademark policy ([TRADEMARKS.md](../../TRADEMARKS.md)).

## Who it serves

- **Everyone using an instance:** they can see what they are running, under which terms, and get its source.
- **Whoever hosts a modified build for others:** `SOURCE_URL` points the offer at their own source, which §13 obliges
  them to provide.

## How it works

- `server/src/about.ts`: `about()` builds the notices. `VERSION` comes from the server's `package.json`. The source link
  defaults to the release that version names (`https://github.com/00xE8/archigov/tree/v<version>`), unless `SOURCE_URL`
  is set.
- `GET /api/auth/about`: exempt from sign-in (an explicit `GET` rule in `auth/roles.ts`), so the sign-in page can show the notices.
- The web UI: **About archigov** in the help panel opens the notices in a modal (`web/src/components/About.tsx`). The
  sign-in page carries them on one line. AGPL-3.0 §5(d) accepts a prominent item in a menu.
- No table, no migration, no capability.

## What it deliberately does not do

- It adds no term to the licences. The AGPL already requires a modified version to keep showing equivalent notices
  (§5(d)) and to offer its source (§13).
- It asserts nothing about compliance with the licence by whoever runs an instance. `SOURCE_URL` is theirs to set.
