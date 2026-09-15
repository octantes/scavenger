# Security model

The quest server is **read-public, write-owner-only**, by construction ([the quest server contract](contract.md#quest-server) explains the boundary). A write that isn't a direct loopback connection - or an explicit `--trust-ip` - is refused, and a proxy hop carries `X-Forwarded-For`. Because this is enforced **server-side** at the socket level, a hosted or hand-edited patchbay can never write; only a process on the host machine can.

## SSRF & DNS Rebinding

When the server fetches a quest URL, it pins the fetch, so a hostile resolver **can't rebind it into your internal network** - and the loopback write-gate above means only the owner can even point a quest somewhere.

- The **IP Denylist** catches any host that resolves to a private, link-local, or router address, so a quest can't be pointed at your internal network behind a public-looking domain. Reserved blocks (`0.0.0.0/8`, CGNAT, `100.64/10`, NAT64, TEST-NETs) aren't on the deny-list - harmless since only the owner can register a URL.
- **JSON pinning** pins the fetch to the one validated address: instead of checking an IP once and letting the request re-resolve on its own, `pinnedGet` sets a custom `lookup` that dials that exact address - resolver is consulted once.
- The **headless egress proxy** does the single validated resolution for DOM-scrapes - headless Chromium never resolves DNS itself and can't be forced to, and HTTPS tunnels via `CONNECT`, keeping TLS end-to-end.
- **Redirect validation** re-checks the same rules at every hop.

## Profile modes and cookies

Headless Chromium needs a `--user-data-dir`. The Chromium settings menu (`c`) lets you pick where it comes from:

- The **temporary** (default) profile is a fresh throwaway dir per launch, deleted on exit. No cookies, no history; every scrape is anonymous. The right mode unless a target requires you to be logged into any account.
- The **your profile (live)** mode points headless Chromium at your real browser profile so it reuses your logins. Chromium allows exactly one process per profile dir (with `SingletonLock`), so this only works while your normal browser is closed; if opened, the launch declines and falls back to a temp profile instead of risking corruption.
- The **snapshot cookies** mode copies your session state (Cookies, Local State, Local Storage, Session Storage and IndexedDB) into a scav-owned temp dir and runs headless against that copy (deleted on exit), so your normal browser can stay open. Cookies cover most sites, and the rest allows token/store-backed apps to come across.

## Snapshot cookies - why it looks scarier than it is

Reading another application's cookie store plus its encryption key is exactly the behavioural fingerprint of a credential-stealing **infostealer**. Here's what snapshot mode does and doesn't do:

- **Nothing leaves your machine:** The copy lands in a local temp dir and is read only by your own local Chromium. The quest engine has no telemetry and no outbound path except the SSRF-pinned egress proxy used for the scrapes you configured; it never uploads the cookie store anywhere.
- **The copy is useless to anyone else:** Chrome cookies are encrypted with an OS-bound key (`os_crypt` in `Local State`, itself protected by your login keyring / DPAPI / Keychain). Decryption only succeeds as the **same OS user on the same machine**, and a stolen `scavenger-snapshot-...` dir is inert ciphertext elsewhere.
- **It is strictly opt-in:** The default is *temporary* (no cookies at all). Snapshot mode only happens when you deliberately cycle the profile setting to it in the menu - it is never automatic and never the default.
- **It's the standard, documented way:** Puppeteer/Playwright do the same with a profile or copied cookies - scavenger just makes the copy explicit and local instead of hidden.

Antivirus / EDR keys on the *pattern*, not the intent, so touching Cookies + Local State may flag your build. That's a false positive on local, opt-in, no-exfiltration code - prefer **temporary** or **live** mode under managed endpoint security, or whitelist the process.

## Live-emit - skip impersonation entirely

Profile modes exist because *headless* chromium needs to impersonate your session. The `quest live-emit` kernel.js tool sidesteps all of it, running inside your **real logged-in tab.** Snipe an element, and the tool watches it with a `MutationObserver` and `POST`s each text change to the quest server - so your actual browser is the scraper, removing the auth problem.

The one thing it needs is authorization. A page from another origin can still fire a `POST` at `127.0.0.1` - browsers don't stop the request, only the server can - so the server refuses any cross-origin write that doesn't carry proof of intent: the per-run `scv-token` header (printed in the chromium settings menu and the startup log). You paste the token into the kernel once, along with the channel name and API URL, and a *live badge* pins to each watched element.

Watchers persist while the page stays loaded - a full reload kills the kernel with them, and a server restart mints a new per-run token, so watchers stop themselves. The quest arrives on the patchbay as a normal topic - wire it into any node, like any other scraped quest.

## Harvest output

A **harvest is kept, not connected**: scripts are stripped and every network path (fetch, beacon, websocket) is removed, so the copy works forever and phones nothing. The one exception is a visible `<iframe>` - kept because it holds content you chose to carry. Embeds without visual content are fully purged, so a fully sealed patchbay never contains embeds you can see.

## Deploying a patchbay with live data

Host the published HTML on any host. To give it live quests, run `quests.mjs` behind a reverse proxy on the same origin and **proxy `GET /quests` only - never proxy `POST`/`DELETE`.** That keeps the write surface loopback-only while letting visitors read. For a fully static option, use `--output feed.json` and serve the file.

A published patchbay bakes no server address - it reads from whatever origin serves it, which is why the proxy above needs no configuration. To point one somewhere else, open it with `?quest-api=<url>`, the same override the patchbay takes. That is a cross-origin read, which the quest host already allows; the same-origin proxy stays the path of least resistance.
