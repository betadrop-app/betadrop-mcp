# @betadrop/mcp

> Distribute iOS & Android builds to testers — right from your AI-powered IDE.

**BetaDrop MCP** connects your AI coding assistant (Claude, Cursor, Copilot, etc.) to [BetaDrop](https://betadrop.app) so you can publish builds, track releases, and manage API tokens — all through natural language prompts. No browser, no CLI, no context-switching.

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

Your credentials are saved to `$XDG_CONFIG_HOME/betadrop/config.json` when that variable is set, otherwise `~/.betadrop/config.json`, with `0600` permissions (owner-read only). On logout, the token is revoked on the server and the config file is removed.

✅ **You're all set!** Now try any of these prompts 👇

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

#### 📋 Build History

| Prompt | What Happens |
|--------|--------------|
| `"Show my recent BetaDrop builds"` | Lists your latest builds across both platforms |
| `"List my iOS builds"` | Filters to iOS only |
| `"Show all expired builds on BetaDrop"` | Lists builds that have hit their expiry limit |
| `"Any expired Android builds?"` | Expired builds filtered by platform |
| `"Get the install link for my last build"` | Retrieves the shareable URL |

#### 🔑 Token Management

| Prompt | What Happens |
|--------|--------------|
| `"Show my BetaDrop API tokens"` | Lists all active tokens with abilities and expiry |
| `"Create a BetaDrop token for CI called 'GitHub Actions'"` | Creates a new token scoped for CI |
| `"Make a read-only token called 'QA Team'"` | Creates a token whose abilities are recorded as `read` only |
| `"Create a token that expires in 30 days"` | Auto-expiring token for temporary access |
| `"Revoke BetaDrop token abc-123"` | Permanently revokes a token |

#### 👤 Account

| Prompt | What Happens |
|--------|--------------|
| `"Am I logged in to BetaDrop?"` | Shows your email, token details, and API URL |
| `"Log out of BetaDrop"` | Revokes the token server-side and clears local config |

---

## 📖 All Available Tools

### Authentication

| Tool | What It Does |
|------|--------------|
| `betadrop_login` | Save and validate your API token |
| `betadrop_logout` | Revoke the token on the server and clear local credentials |
| `betadrop_whoami` | Show your account email, token name, and expiry |

---

### Publishing Builds

| Tool | What It Does |
|------|--------------|
| `betadrop_publish` | Upload an `.ipa` or `.apk` and get a shareable install link |
| `betadrop_upload_status` | Get the result (install link) of the most recent `betadrop_publish` upload. Takes no parameters — called automatically when a large build outruns the 90-second publish window |

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

> **Expiry is capped by your plan.** `none` — a permanent link — is a paid-plan feature; on a plan
> without it the build is stored as a dated one instead of being rejected. `expiryTimeDays` is
> clamped to your plan's maximum build retention on every plan. When either happens the server
> returns a `retentionClamp` object (`requestedDays`, `appliedDays`, `maxDays`, `permanentDenied`,
> `message`) and the tool result appends a ⚠️ line explaining what was applied. Note it is reported
> only when the plan actually shortened something you asked for: send no `expiryTimeDays` and it
> stays null even if your account default was clamped down. Current per-plan day ceilings live in
> `src/lib/limits.json` rather than being restated here.

> **How uploads work:** The file is validated locally (ZIP magic bytes check) and uploaded, with progress notifications streamed to your AI client in 5% increments. The install link comes back in the tool result. Builds that take longer than 90 seconds keep uploading in the background so the tool call does not time out — the assistant then calls `betadrop_upload_status` to fetch the link. A status file at `~/.betadrop/upload_status.json` tracks the upload in real time.

---

### Build History

| Tool | What It Does |
|------|--------------|
| `betadrop_list_builds` | List recent builds, with optional filters |
| `betadrop_list_expired_builds` | List only expired builds (convenience shortcut) |

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

Each result includes the build name, version, platform, file size, status, dates, and a shareable install link.

---

### Token Management

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

> Abilities are recorded on the token and shown by `betadrop_token_list`; publishing builds requires
> the `publish` ability. Do not treat a `read` token as a hard security boundary across every
> endpoint — scope it to a plan, and revoke tokens you no longer hand out.

> ⚠️ The plaintext token is shown **exactly once** at creation. Copy it immediately!

---

### Quick Help

| Tool | What It Does |
|------|--------------|
| `betadrop_help` | Show a full offline reference of all tools and example prompts |

---

## ⚙️ Configuration

Set these environment variables to override the defaults:

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
- Make sure Node.js 18+ is installed: `node --version`
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

---

## 📚 Links

- [BetaDrop](https://betadrop.app) — the build distribution platform
- [Model Context Protocol](https://modelcontextprotocol.io) — the open standard powering this integration
- [Report an Issue](https://betadrop.app/feedback/)

## Requirements

- **Node.js 18+**
- A [BetaDrop](https://betadrop.app) account
- One of the supported AI editors (Claude, Cursor, VS Code, Windsurf, Zed, Antigravity)

## License

MIT
