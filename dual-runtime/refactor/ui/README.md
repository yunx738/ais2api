# Console visual reference

The console layout and visual theme follow [james-6-23/codex2api](https://github.com/james-6-23/codex2api/tree/54be7aeb0d9489485ce53a0439063f127a04d129), inspected at commit `54be7aeb0d9489485ce53a0439063f127a04d129`.

The reference informs the sidebar, mobile navigation, color palette, cards, account table, usage panels, and compact request records. These are implemented in AIS2API's existing vanilla HTML/CSS/JavaScript console, using AIS2API's own API contracts and branding.

Quota bars represent the local per-model count ledger. Unknown usage and costs remain unknown; the interface does not invent upstream balances, model prices, or unsupported metrics.

Run `npm run test:ui` from the repository root to check navigation, responsive layouts, API failure handling, and the console's existing interactions with isolated fixtures. The check requires Playwright Chromium or `AIS_BROWSER_EXECUTABLE` pointing to a compatible browser.
