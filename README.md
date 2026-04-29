# Claude Ops

A real-time local dashboard for monitoring and managing your [Claude Code](https://claude.ai/code) sessions.

See what every running Claude agent is doing, get OS push notifications when one needs your input, browse your filesystem, and launch or kill sessions — all from one browser tab.

---

## Features

- **Live session monitoring** — status updates via Claude Code hooks (Working, Thinking, Idle, Needs input)
- **Activity feed per session** — see every tool call as it happens (Bash, Read, Write, WebSearch…)
- **Subagent tracking** — when a session spawns child agents, they appear as chips on the card
- **Task progress** — tracks TaskCreate / TaskCompleted events with a progress bar
- **PS fallback** — sessions that haven't fired a hook yet are still discovered via `ps` and shown as Idle
- **File browser** — browse your filesystem, right-click any folder to start a new Claude session in Terminal
- **Push notifications** — get an OS notification when a session needs confirmation, even with the tab in the background
- **Kill sessions** — right-click any session card to send SIGTERM

---

## Requirements

- macOS (uses `osascript` to open Terminal and `lsof` for process discovery)
- Node.js 20+
- [Claude Code](https://claude.ai/code) CLI

---

## Setup

### 1. Install prerequisites (if not already installed)

```bash
# Node.js 20+  —  https://nodejs.org
node --version

# Claude Code
npm install -g @anthropic-ai/claude-code
```

### 2. Clone and install

```bash
git clone https://github.com/abhishek421/claude-ops.git
cd claude-ops
npm install
```

### 3. Run setup

```bash
npm run setup
```

This does three things automatically:
- Generates Web Push (VAPID) keys and writes them to `.env`
- Sets `BASE_DIR` to your home directory in `.env`
- Patches `~/.claude/settings.json` to add all hooks pointing to your local clone

### 4. Start the dashboard

```bash
npm start
```

Open **http://localhost:4242** in your browser.

### 5. Enable push notifications (optional)

Click **🔕 Enable alerts** in the top-right corner and allow notifications. You'll get an OS notification whenever a session needs your input, even with the tab in the background.

### 6. Start a Claude Code session

Open a new terminal, `cd` into any project, and run `claude`. The session will appear in the dashboard immediately.

> **Note:** any Claude Code sessions that were already open before `npm run setup` won't have the new hooks active. Start a fresh session after setup for full hook coverage. Existing sessions still appear via process discovery but show as `Idle` only.

---

## Configuration

All config lives in `.env` (created by `npm run setup`, never committed):

| Variable | Default | Description |
|---|---|---|
| `VAPID_PUBLIC_KEY` | — | Web Push public key (auto-generated) |
| `VAPID_PRIVATE_KEY` | — | Web Push private key (auto-generated) |
| `VAPID_EMAIL` | `mailto:you@example.com` | Contact email for push provider |
| `BASE_DIR` | `$HOME` | Root directory for the file browser |
| `PORT` | `4242` | Server port |

---

## How Hooks Work

`npm run setup` writes entries like this into `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse":        [{ "matcher": "", "hooks": [{ "type": "command", "command": "bash \"/path/to/claude-ops/hq-notify.sh\" PreToolUse",        "async": true }] }],
    "Stop":              [{ "matcher": "", "hooks": [{ "type": "command", "command": "bash \"/path/to/claude-ops/hq-notify.sh\" Stop",              "async": true }] }],
    "PermissionRequest": [{ "matcher": "", "hooks": [{ "type": "command", "command": "bash \"/path/to/claude-ops/hq-notify.sh\" PermissionRequest", "async": true }] }]
  }
}
```

Full list of wired hooks: `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, `PermissionRequest`, `SubagentStart`, `SubagentStop`, `TaskCreated`, `TaskCompleted`, `Notification`, `CwdChanged`.

All hooks are `async: true` — they never block Claude.

`hq-notify.sh` reads the hook JSON from stdin and POSTs it to the local server on port 4242. If the server isn't running, the script fails silently.

---

## Push Notifications

1. Start the server and open `http://localhost:4242`
2. Click **🔕 Enable alerts** in the top-right
3. Allow notifications in the browser prompt

You'll get an OS notification whenever a session fires `PermissionRequest` (needs your approval) or `Notification`. Clicking the notification focuses or opens the dashboard tab.

---

## License

MIT — see [LICENSE](LICENSE)
