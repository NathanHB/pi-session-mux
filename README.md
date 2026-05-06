# 📡 pi-session-mux

Session multiplexer for [pi](https://pi.dev) — switch between sessions with a floating overlay.

![pi-package](https://img.shields.io/badge/pi-package-blue)

## Install

```bash
pi install git:github.com/nathanche26/pi-session-mux
```

Or try without installing:

```bash
pi -e git:github.com/nathanche26/pi-session-mux
```

## Usage

- **`Ctrl+Shift+S`** — open the session picker overlay
- **`/sessions`** — open the session picker via command

## Features

- Lists all sessions across all projects
- Fuzzy search to filter sessions
- Shows session name (or first message), date, model, and CWD
- Highlights the current session with `●`
- Enter to switch, Esc to cancel

## How it works

- Uses `SessionManager.listAll()` to discover all sessions
- Parses each session file for the first user message and model info
- Uses a `SelectList` overlay with theme-aware styling
- Switches via `ctx.switchSession()` (same mechanism as `/resume`)
