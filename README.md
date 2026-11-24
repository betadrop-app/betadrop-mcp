<img src="https://betadrop.app/images/logo/BetaDropLogo.png" width="56" alt="BetaDrop" />

# @betadrop/mcp

<!-- Absolute URLs only. npm renders this file on its own domain, so a relative src or href
     resolves against npmjs.com and 404s — and the tarball ships only dist/, package.json and
     this README, so there is no LICENSE file to reach even when a repository is set. Do not add
     a badge for a workflow the public cannot see: it renders as a red "repo or workflow not
     found" error at the top of the page. -->

[![npm version](https://img.shields.io/npm/v/@betadrop/mcp?color=0b64fc&label=npm)](https://www.npmjs.com/package/@betadrop/mcp)
[![MCP Registry](https://img.shields.io/badge/MCP%20Registry-io.github.betadrop--app%2Fbetadrop--mcp-0b64fc)](https://registry.modelcontextprotocol.io)
[![Node](https://img.shields.io/node/v/@betadrop/mcp?color=0b64fc)](https://nodejs.org)
[![License: MIT](https://img.shields.io/npm/l/@betadrop/mcp?color=0b64fc)](https://opensource.org/licenses/MIT)
[![betadrop-app/betadrop-mcp MCP server](https://glama.ai/mcp/servers/betadrop-app/betadrop-mcp/badges/score.svg)](https://glama.ai/mcp/servers/betadrop-app/betadrop-mcp)

> **"Publish this build and send me the install link."**
> Say that to your AI assistant and a tester can be installing the app thirty seconds later.

[BetaDrop](https://betadrop.app) puts an iOS `.ipa` or Android `.apk` behind an over-the-air install
link: testers open the link on their phone and install straight from the browser — no TestFlight
review wait, no Play track, no tester accounts. If you have used Diawi or Firebase App Distribution,
it does the same job.

**BetaDrop MCP** moves that step to the other side of your AI assistant. Claude, ChatGPT, Cursor,
Copilot, Windsurf, Zed and Antigravity can publish builds, check they will install, manage
standing links, devices and webhooks, and read tester feedback through ordinary prompts — no
browser tab, no CLI, no leaving the editor.

```bash
claude mcp add betadrop -s user -- npx -y @betadrop/mcp
```

**28 tools. One npx command. No build step.** Your assistant already knows how to use them — you
never type a tool name.

### Two ways to connect

| | This package (`npx -y @betadrop/mcp`) | Hosted connector (`https://api.betadrop.app/mcp`) |
|---|---|---|
| **Runs** | On your computer, over stdio | On BetaDrop's servers, over Streamable HTTP |
| **Sign-in** | An API token: `BETADROP_TOKEN`, or the config file that `betadrop_login` and the BetaDrop CLI write | Your BetaDrop account in the browser (OAuth) — no token to copy |
| **Clients** | Any client that starts a local MCP server: Claude Code, Claude Desktop, Cursor, VS Code, Windsurf, Zed, Antigravity | Any client that connects to a remote MCP server with OAuth sign-in: Claude, ChatGPT, Cursor, VS Code, Claude Code |
| **Tools** | 28 | 23 — all but the five that read or write files on your computer |
| **Publishing** | A build file on disk, an upload link, or a public https link | An upload link you open in the browser, or a build already at a public https link |
| **Needs** | Node.js 20 or newer | Nothing to install |

The [Quick Start](#-quick-start-3-steps) below sets up this package. For the hosted connector, see
[Hosted connector](#-hosted-connector-no-install).

---

## ⚡ Quick Start (3 Steps)

### Step 1 — Get a BetaDrop API Token

1. Sign up or log in at [betadrop.app](https://betadrop.app)
2. Go to **Settings → Developer**
3. Under **API tokens**, click **Create token**, give it a name (e.g. `"My IDE"`), and copy the token  
   _(It starts with `bd_live_...` — save it somewhere safe, it's shown only once!)_

### Step 2 — Add the MCP Server to Your Editor

> [!TIP]
> **🤖 AI-Native Installation (Easiest)**
> Since you are already using an AI assistant (like Cursor Composer, Claude, Copilot, or Antigravity), you don't need to edit configuration files manually! Just paste one of the following prompts directly into your AI chat:
>
> * **Cursor**: `"Add the @betadrop/mcp server to my global Cursor mcp.json config"`
> * **Antigravity**: `"Add the @betadrop/mcp server to my Antigravity mcp_config.json"`
> * **VS Code (Copilot)**: `"Add the @betadrop/mcp server to my workspace .vscode/mcp.json"`
> * **Claude Desktop**: `"Add the @betadrop/mcp server to my Claude Desktop config"`
>
> The AI will automatically locate, create, or update the configuration file for you. Once it is done, simply refresh/restart your editor.

Otherwise, pick your editor below to configure it manually.


<details>
<summary><strong>Claude Code</strong></summary>

Run one command in your terminal:

```bash
claude mcp add betadrop -s user -- npx -y @betadrop/mcp
```

> This installs BetaDrop globally across all your Claude Code projects.  
> For a single project only, drop the `-s user` flag.

**Verify it worked:**

```bash
claude mcp list
```

Start a new Claude Code session and type `/mcp` to confirm the connection.

</details>

<details>
<summary><strong>Claude Desktop</strong></summary>

Open your config file:

| OS | Path |
|----|------|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |

Add this inside the file:

```json
{
  "mcpServers": {
    "betadrop": {
      "command": "npx",
      "args": ["-y", "@betadrop/mcp"]
    }
  }
}
```

**Restart Claude Desktop.** BetaDrop tools will appear in the 🔧 tools panel.

</details>

<details>
<summary><strong>Cursor</strong></summary>

Create `.cursor/mcp.json` in your project root:

```json
{
  "mcpServers": {
    "betadrop": {
      "command": "npx",
      "args": ["-y", "@betadrop/mcp"]
    }
  }
}
```

Or for global access, create/edit `~/.cursor/mcp.json` with the same content.

Go to **Settings → MCP** and click **Refresh** to pick up the new server.

</details>

<details>
<summary><strong>VS Code (GitHub Copilot)</strong></summary>

Create `.vscode/mcp.json` in your project root:

```json
{
  "servers": {
    "betadrop": {
      "command": "npx",
      "args": ["-y", "@betadrop/mcp"]
    }
  }
}
```

Or add it globally:

| OS | Path |
|----|------|
| macOS | `~/Library/Application Support/Code/User/mcp.json` |
| Windows | `%APPDATA%\Code\User\mcp.json` |
| Linux | `~/.config/Code/User/mcp.json` |

Use Copilot in **Agent mode** to access BetaDrop tools.

</details>

<details>
<summary><strong>Windsurf</strong></summary>

Edit `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "betadrop": {
      "command": "npx",
      "args": ["-y", "@betadrop/mcp"]
    }
  }
}
```

</details>

<details>
<summary><strong>Zed</strong></summary>

Add to your Zed settings file:

| OS | Path |
|----|------|
| macOS | `~/Library/Application Support/Zed/settings.json` |
| Linux | `~/.config/zed/settings.json` |

```json
{
  "context_servers": {
    "betadrop": {
      "command": {
        "path": "npx",
        "args": ["-y", "@betadrop/mcp"]
      }
    }
  }
}
```

</details>

<details>
<summary><strong>Antigravity (Google)</strong></summary>

Open MCP settings from **Settings → MCP Servers** or edit the config file directly:

| OS | Path |
|----|------|
| macOS | `~/.gemini/antigravity-ide/mcp_config.json` |
| Windows | `%USERPROFILE%\.gemini\antigravity-ide\mcp_config.json` |

```json
{
  "mcpServers": {
    "betadrop": {
      "command": "npx",
      "args": ["-y", "@betadrop/mcp"]
    }
  }
}
```

Restart Antigravity to pick up the new server.

</details>

### Step 3 — First-Time Setup

After adding the MCP server, authenticate with your BetaDrop API token. Open your AI assistant and type:

> **"Log me in to BetaDrop with token bd_live_xxxxxxxx"**

Your credentials are saved to `$XDG_CONFIG_HOME/betadrop/config.json` when that variable is set, otherwise `~/.betadrop/config.json`, with `0600` permissions (owner-read only). On logout, the token is revoked on the server and removed from the config file; the file itself is deleted unless the BetaDrop CLI keeps settings of its own there. If revoking fails, logout says so and where to revoke the token by hand.

The BetaDrop CLI uses the same file, so on a machine where `betadrop login` has already run there
is nothing to do. For CI or a headless setup, set `BETADROP_TOKEN` instead — see
[Configuration](#-configuration).

✅ **You're all set!** Now try any of these prompts 👇

---

## 🌐 Hosted connector (no install)

BetaDrop also runs this server for you:

```
https://api.betadrop.app/mcp
```

Add that URL to a client that supports remote MCP servers, sign in to your BetaDrop account when it
opens the browser, and approve access. There is no token to copy and nothing to install.

| Client | How to add it |
|---|---|
| **Claude** (web, desktop, mobile) | A custom connector with the URL: **Customize → Connectors → Add → Add custom connector**. On Team and Enterprise plans an owner adds it under **Organization settings → Connectors** and each member clicks **Connect**. |
| **Claude Code** | `claude mcp add --transport http betadrop https://api.betadrop.app/mcp`, then `/mcp` in Claude Code to sign in. Add `--scope user` to have it in every project. |
| **ChatGPT** | A custom MCP server with the URL, in developer mode, signing in with OAuth. Which plans have it, and where, is up to OpenAI. |
| **Cursor** | A `url` entry in `.cursor/mcp.json` (one project) or `~/.cursor/mcp.json` (every project): `{ "mcpServers": { "betadrop": { "url": "https://api.betadrop.app/mcp" } } }` |
| **VS Code (Copilot)** | An MCP server of type HTTP with the URL. |
| **Other clients** | Any client that speaks Streamable HTTP and the MCP authorization spec. |

Menu names move; the paths above are from each vendor's documentation on 2026-11-24.

**How sign-in works.** OAuth 2.1 with PKCE: the client registers itself (dynamic client
registration) and sends you to BetaDrop, where you sign in and approve or deny the access it asks
for. `read` lets it look at builds, analytics, feedback, devices, webhooks and tokens; `publish`
also lets it change things (publish, delete, re-point standing links, invite devices, add
webhooks, create and revoke tokens) and includes `read`. A client that names no scope is asking
for full access, and the consent page says so. The access token is refreshed automatically, so a
connector you keep using never asks you to sign in again. It shows up under **Settings → Developer
→ API tokens** named after the client, for example "Claude (connector)": revoke it there to
disconnect.

**What it can't do.** It runs on BetaDrop's servers, so it cannot reach files on your computer:
`betadrop_publish`, `betadrop_upload_status`, `betadrop_inspect`, `betadrop_login` and
`betadrop_logout` are only in this package. A build you attach in the chat does not reach BetaDrop
either. To publish, the assistant uses one of two tools, then `betadrop_check_upload` for the
install link:

- **`betadrop_create_upload_link`** — a link for one build, valid for 30 minutes. You open it and
  drop the `.ipa` or `.apk` in the browser. The link itself is the permission, so don't share it.
- **`betadrop_publish_from_url`** — for a build already at a public https link, such as a CI
  artifact or a GitHub release asset. BetaDrop downloads it.

Nothing checks a build before it is published there (that is `betadrop_inspect`, which is local),
but the publish result still says when a build will not install. The hosted connector sends no
upload progress.

---

## 🚀 Try These Prompts

You don't need to memorize any tool names — just talk to your AI assistant naturally:

#### 📦 Publishing Builds

| Prompt | What Happens |
|--------|--------------|
| `"Publish ./build/MyApp.ipa to BetaDrop"` | Uploads the IPA and returns an install link |
| `"Upload MyApp.apk with notes 'Fixed login crash on Android 14'"` | Publishes with release notes visible to testers |
| `"Push the latest IPA to BetaDrop, expire after 7 days"` | Sets a time-based expiry on the build |
| `"Upload MyApp.ipa and send me the install link"` | Returns a shareable OTA install URL |
| `"Give me an upload link for my APK"` | A one-time link to drop the file on in your browser — the way to publish from the hosted connector |
| `"Publish https://github.com/me/app/releases/download/v2/app.apk"` | BetaDrop downloads the build itself and returns the install link |

#### 📋 Build History

| Prompt | What Happens |
|--------|--------------|
| `"Show my recent BetaDrop builds"` | Lists your latest builds across both platforms |
| `"List my iOS builds"` | Filters to iOS only |
| `"Show all expired builds on BetaDrop"` | Lists builds that have hit their expiry limit |
| `"Any expired Android builds?"` | Expired builds filtered by platform |
| `"Get the install link for my last build"` | Retrieves the shareable URL |
| `"How is my latest build doing?"` | Installs, devices, failed installs and a daily trend for one build |

#### 🔑 Token Management

| Prompt | What Happens |
|--------|--------------|
| `"Show my BetaDrop API tokens"` | Lists all active tokens with abilities and expiry |
| `"Create a BetaDrop token for CI called 'GitHub Actions'"` | Creates a new token scoped for CI |
| `"Make a read-only token called 'QA Team'"` | Creates a token whose abilities are recorded as `read` only |
| `"Create a token that expires in 30 days"` | Auto-expiring token for temporary access |
| `"Revoke BetaDrop token abc-123"` | Permanently revokes a token |

#### ✅ Release Checks, Links and Devices

| Prompt | What Happens |
|--------|--------------|
| `"Will build/MyApp.ipa install from a link?"` | `betadrop_inspect` reads the profile and signing without publishing |
| `"Publish MyApp.ipa to the acme-beta standing link"` | Publishes and points the standing link testers already have at it |
| `"What did testers say about the last build?"` | Reads tester feedback |
| `"Export my test devices for the Apple portal"` | Returns the tab-separated devices file |
| `"Post new builds to this Slack webhook: https://hooks.slack.com/…"` | Creates a webhook formatted for Slack |

#### 👤 Account

| Prompt | What Happens |
|--------|--------------|
| `"Am I logged in to BetaDrop?"` | Shows your email, token details, and API URL |
| `"Log out of BetaDrop"` | Revokes the token server-side and clears local config |

#### 🔁 Chained, in one turn

Because these are tools and not a chat bot, your assistant can string them together:

> **"Build the release APK, publish it to BetaDrop with the last commit message as the notes, and give me the install link."**

The build runs in your terminal, `betadrop_publish` uploads the artifact, and the link comes back
in the same reply.

---

## 📖 All Available Tools

Twenty-eight tools across nine areas. The hosted connector has 23 of them: the five marked
**Local only** read or write files on your computer. You never call these by name — the assistant
picks them.

### Account

| Tool | What It Does |
|------|--------------|
| `betadrop_welcome` | Say "hi": your account, latest builds with install links, and what to ask next |
| `betadrop_whoami` | Your account email and the token in use (name, expiry, last use); the local server also shows which API URL it talks to |
| `betadrop_login` | **Local only.** Validate an API token and save it to the config file the CLI shares |
| `betadrop_logout` | **Local only.** Revoke the token on the server and clear local credentials |

---

### Publishing Builds

| Tool | What It Does |
|------|--------------|
| `betadrop_publish` | **Local only.** Upload an `.ipa` or `.apk` from disk and get a shareable install link |
| `betadrop_upload_status` | **Local only.** The result (install link) of the most recent `betadrop_publish` upload. Takes no parameters — the assistant calls it when a large build outruns the 90-second publish window |
| `betadrop_create_upload_link` | A one-time link, valid for 30 minutes, where you drop an `.apk` or `.ipa` in a browser — for Claude, ChatGPT and other clients whose chat attachments cannot reach BetaDrop |
| `betadrop_publish_from_url` | Publish a build that is already online (a CI artifact, a GitHub release asset); BetaDrop downloads it |
| `betadrop_check_upload` | The status of an upload link or URL publish, and the install link once it is live |

Only `.ipa` and `.apk` files are accepted. An `.aab` is refused: testers need an `.apk`.

**`betadrop_publish` parameters:**

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `filePath` | string | ✅ | Absolute path to the `.ipa` or `.apk` file |
| `name` | string | | Override the app display name |
| `version` | string | | Override the version string (e.g. `1.2.3`) |
| `buildNumber` | string | | Override the build number |
| `bundleId` | string | | Override the bundle / package ID |
| `notes` | string | | Release notes shown on the install page |
| `expiryType` | string | | `none` · `time` · `downloads` · `devices` · `combined`. `none` (a permanent link) requires a paid plan — see below |
| `expiryTimeDays` | number | | Expire after N days (use with `time` or `combined`). Clamped to your plan's maximum build retention |
| `expiryDownloadLimit` | number | | Expire after N downloads (use with `downloads` or `combined`) |
| `expiryDeviceLimit` | number | | Expire after N unique devices (use with `devices` or `combined`) |
| `standingLink` | string | | Slug of a [standing link](https://betadrop.app/standing-links/) to point at this build once it is live (must already be claimed on the account) |

**`betadrop_create_upload_link` and `betadrop_publish_from_url` parameters:**

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `url` | string | ✅ for `betadrop_publish_from_url` | Public `https://` URL of the `.apk` or `.ipa` (that tool only) |
| `name` | string | | Override the app's display name |
| `notes` | string | | Release notes shown on the install page |
| `expiryDays` | number | | Expire the build after this many days (1–3650). Clamped to your plan's maximum build retention |
| `channel` | string | | Slug of a standing link to point at the new build |

`betadrop_check_upload` takes the upload `id` that either tool returned.

> **Expiry is capped by your plan.** `none` — a permanent link — is a paid-plan feature; on a plan
> without it the build is stored as a dated one instead of being rejected. `expiryTimeDays` and
> `expiryDays` are clamped to your plan's maximum build retention on every plan. When either
> happens the server returns a `retentionClamp` object (`requestedDays`, `appliedDays`, `maxDays`,
> `permanentDenied`, `message`) and the tool result adds a line explaining what was applied. Note
> it is reported only when the plan actually shortened something you asked for: send no expiry and
> it stays null even if your account default was clamped down. The day ceilings for each plan are
> on the [pricing page](https://betadrop.app/pricing/).

> **What a publish result tells you.** The install link and, only when they apply: what your plan
> did to the expiry you asked for; that the same file is already live under
> another link; the standing link that now serves the build; that the build is held for review, so
> its link refuses testers until the review finishes; install warnings for a build that will not
> install; and for Android, whether the app is registered for Google's developer verification and
> whether its signing key changed since the previous build.

> **How uploads work:** The file is checked locally (extension and ZIP magic bytes) and uploaded.
> Clients that ask for progress get MCP progress notifications as it goes, in 5% steps. The install
> link comes back in the tool result. Builds that take longer than 90 seconds keep uploading in the
> background so the tool call does not time out — the assistant then calls
> `betadrop_upload_status` to fetch the link. A status file at `~/.betadrop/upload_status.json`
> tracks the upload in real time.

---

### Builds and Analytics

| Tool | What It Does |
|------|--------------|
| `betadrop_list_builds` | List recent builds, with optional filters |
| `betadrop_list_expired_builds` | List only expired builds (convenience shortcut) |
| `betadrop_build_analytics` | Installs, unique devices, failed installs and why, a daily trend, the platform split, and top devices and countries for one build |
| `betadrop_delete_build` | Delete a build (`buildId`); its install link stops working |
| `betadrop_get_feedback` | The feedback testers left on a build (`buildId`): bug reports, ratings and notes |

**`betadrop_list_builds` parameters:**

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `platform` | string | | `ios` or `android` — omit to list all |
| `status` | string | | `active` · `expired` · `disabled` · `deprecated` · `latest` |
| `page` | number | | Page number (default: `1`) |
| `perPage` | number | | Results per page (default: `20`, max: `100`) |

**`betadrop_list_expired_builds` parameters:**

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `platform` | string | | `ios` or `android` — omit to list all |
| `page` | number | | Page number (default: `1`) |
| `perPage` | number | | Results per page (default: `20`, max: `100`) |

Each listed build shows its ID, name, version, platform, file size, status, dates and install
link, and `betadrop_list_builds` adds installs and devices. The ID is what `betadrop_delete_build`,
`betadrop_get_feedback` and `betadrop_point_standing_link` take.

**`betadrop_build_analytics` parameters:**

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `build` | string | | The build's ID or short ID, or an app name (the newest build with that name). It matches names, not versions, among your 500 most recent builds. Omit for the most recent build |
| `days` | number | | Length of the daily trend, 1–90 (default: `14`). The install, device and failure totals cover the build's whole life |

---

### Release Checks

| Tool | What It Does |
|------|--------------|
| `betadrop_inspect` | **Local only.** Will an `.ipa`/`.apk` install from a link? Profile type and expiry, bundle ID match, signing, `testOnly`/`debuggable`. Nothing is published |

### Standing Links

| Tool | What It Does |
|------|--------------|
| `betadrop_list_standing_links` | Standing links, the build each serves, and follower counts |
| `betadrop_point_standing_link` | Point one (`slug`) at an already-uploaded build (`buildId`); followers are emailed |

`betadrop_publish` also accepts `standingLink`, and the two remote publishing tools `channel`, to
point one at the new build as it goes live.

### iOS Devices

| Tool | What It Does |
|------|--------------|
| `betadrop_list_devices` | Registered iOS devices (UDIDs) |
| `betadrop_export_devices` | The tab-separated devices file Apple's portal and fastlane `register_devices` accept |
| `betadrop_invite_device` | A link a tester opens on their iPhone to register its UDID: emailed to them with `name` and `email`, or the account's shareable link with `open: true` |

### Webhooks

| Tool | What It Does |
|------|--------------|
| `betadrop_list_webhooks` | Webhooks on the account |
| `betadrop_create_webhook` | Send events to a URL, Slack or Discord (`format` is detected from the URL). A JSON webhook's signing secret is shown once |
| `betadrop_test_webhook` | Deliver a test event now and report the answer |
| `betadrop_delete_webhook` | Remove a webhook |

Events: `build.published`, `standing_link.updated`, `build.expiring`, `build.file_missing` and
`tester.installed`. A new webhook gets all of them except `tester.installed` unless you name them.

---

### API Tokens

| Tool | What It Does |
|------|--------------|
| `betadrop_token_list` | List all your active (non-revoked) API tokens |
| `betadrop_token_create` | Create a new scoped token (plaintext shown only once!) |
| `betadrop_token_delete` | Permanently revoke a token by ID |

**`betadrop_token_create` parameters:**

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `name` | string | ✅ | Label for the token (max 100 chars) |
| `abilities` | string[] | | `["publish"]`, `["read"]`, or `["*"]` (default: all) |
| `expiresInDays` | number | | Token lifetime in days (1–365). Omit for no expiry |

> Abilities are enforced on every endpoint: a `read` token can list builds, read feedback and run
> `betadrop_inspect`, but cannot publish, delete, or change links, devices or webhooks.

> ⚠️ The plaintext token is shown **exactly once** at creation. Copy it immediately!

---

### Quick Help

| Tool | What It Does |
|------|--------------|
| `betadrop_help` | A reference of every tool, its inputs and example prompts. On the hosted connector it lists only the tools there |

---

## ⚙️ Configuration

Set these environment variables to override the defaults. They apply to this package; the hosted
connector needs none.

| Variable | Default | Description |
|----------|---------|-------------|
| `BETADROP_API_URL` | `https://api.betadrop.app` | API server URL (for self-hosted) |
| `BETADROP_APP_URL` | `https://betadrop.app` | Frontend URL for install links |
| `BETADROP_TOKEN` | _(none)_ | Token for CI — skips the local config file |

To set them for the MCP server, add an `env` block alongside `command` and `args` in the editor
config from [Step 2](#step-2--add-the-mcp-server-to-your-editor):

```json
{
  "mcpServers": {
    "betadrop": {
      "command": "npx",
      "args": ["-y", "@betadrop/mcp"],
      "env": { "BETADROP_TOKEN": "bd_live_xxx" }
    }
  }
}
```

With `BETADROP_TOKEN` set there is no need to log in — the server uses it directly:

```bash
BETADROP_TOKEN=bd_live_xxx betadrop-mcp
```

---


## ❓ Troubleshooting

**"Tool not found" or no BetaDrop tools showing up?**
- Make sure Node.js 20 or newer is installed: `node --version`. 0.4.0 needs 20; 0.3.x ran on 18.
- Restart your editor after adding the MCP config
- In Claude Code, run `/mcp` to check the server status
- In Cursor, go to **Settings → MCP** and click **Refresh**

**"You are not logged in"?**
- Ask your AI: `"Log me in to BetaDrop with token bd_live_..."`
- Or set the `BETADROP_TOKEN` env variable in your MCP config — see [Configuration](#-configuration)

**Upload seems stuck?**
- Builds that take longer than 90 seconds keep uploading in the background so the tool call does not time out
- Ask your assistant to check the upload status (it will call `betadrop_upload_status`) — that returns the install link once the upload lands
- You can also watch `~/.betadrop/upload_status.json` directly

**Token expired or revoked?**
- Create a new token at [betadrop.app → Settings → Developer → API tokens](https://betadrop.app)
- Log in again with the new token

**The hosted connector asks you to sign in again?**
- Its access was revoked under Settings → Developer → API tokens, or it went unused for 90 days.
  Sign in again from your client.

**The assistant says it cannot read your build file?**
- On the hosted connector it never can. Ask for an upload link ("give me an upload link for my
  APK") or give it a public https link to the build — or use this package, which reads files from
  disk.

**The iOS build downloads on the phone but will not open?**
- An ad-hoc `.ipa` only installs on devices that were in the provisioning profile when it was signed — publishing it does not change that. Send the tester the [UDID checker](https://betadrop.app/udid-checker/), add the device in the Apple Developer portal, and re-sign.

---

## 🆕 What's new in 0.4.0

- **Five more tools, 28 in all:** `betadrop_welcome`, `betadrop_build_analytics`,
  `betadrop_create_upload_link`, `betadrop_publish_from_url` and `betadrop_check_upload`, which
  the hosted connector already had.
- **Both protocol versions.** Clients that speak MCP 2026-07-28 get it; older clients keep the
  protocol they already use.
- **Build IDs in listings,** so a build from `betadrop_list_builds` or
  `betadrop_list_expired_builds` can go straight to `betadrop_delete_build`,
  `betadrop_get_feedback` or `betadrop_point_standing_link`.
- **Fuller publish results:** review holds, install warnings, Android developer verification and
  signing-key changes.
- **A complete `betadrop_help`.** On the hosted connector it lists only the tools there.
- **Upload progress** for local publishes, in clients that support MCP progress.
- **`betadrop_whoami` no longer shows the hosted connector's internal address.**
- **`betadrop_publish_from_url` no longer times out** on a slow download: it returns the upload ID
  for `betadrop_check_upload`.
- **Node.js 20 or newer** is required (it was 18).

---

## Also from BetaDrop

The same publish step, on the other two surfaces — one account, one set of API tokens:

| | |
|---|---|
| **[`@betadrop/cli`](https://www.npmjs.com/package/@betadrop/cli)**<br><sub>[source](https://github.com/betadrop-app/betadrop-cli)</sub> | `betadrop publish app.ipa` from your terminal. Prints the install link and a scannable QR code. |
| **[`betadrop-app/upload-action`](https://github.com/betadrop-app/upload-action)** | Publish from a GitHub Actions workflow. The install link lands on the run summary and, optionally, in a pull-request comment that updates itself on every push. |

---

## 📚 Links

- [BetaDrop](https://betadrop.app) — the build distribution platform
- [Model Context Protocol](https://modelcontextprotocol.io) — the open standard powering this integration
- [Report an Issue](https://betadrop.app/feedback/)

## Requirements

- **Node.js 20+** for this package. The hosted connector needs nothing installed.
- A [BetaDrop](https://betadrop.app) account — the free tier needs no card. Retention and
  file-size ceilings by plan are on the [pricing page](https://betadrop.app/pricing/).
- An MCP client: one that starts a local server for this package (Claude Code, Claude Desktop,
  Cursor, VS Code, Windsurf, Zed, Antigravity), or one that connects to a remote server for the
  hosted connector (Claude, ChatGPT, Cursor, VS Code, Claude Code)

## Contributing

Issues and pull requests: <https://github.com/betadrop-app/betadrop-mcp>. If this saved you a
trip to the browser, a ⭐ helps other mobile teams find it.

## License

MIT
