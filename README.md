# AutoAckMention

A [BetterDiscord](https://betterdiscord.app/) plugin that automatically clears the mention badge (the red ping dot) from **specific channels you choose** — after a short, human-like delay.

Useful for noisy channels where you're pinged constantly but don't want the red badge nagging you, while keeping normal unread behavior everywhere else.

## Features

- **Per-channel, opt-in** — only acts on channels you explicitly add. Everything else is untouched.
- **Right-click to toggle** — right-click any channel → **Auto-Ack Mentions** to add/remove it.
- **Settings panel** — view your channel list (`Server > channel (id)`) and remove entries with one click.
- **Human-like delay** — acks 5–10s after the ping instead of instantly, so it doesn't look automated.
- **Clears stale mentions on start** — channels already pinged when Discord launches get cleared too.
- Detects direct mentions, `@everyone`/`@here`, and role mentions.

## Installation

1. Install [BetterDiscord](https://betterdiscord.app/).
2. Download [`AutoAckMention.plugin.js`](./AutoAckMention.plugin.js).
3. Drop it into your BetterDiscord plugins folder:
   - **Windows:** `%AppData%\BetterDiscord\plugins`
   - **macOS:** `~/Library/Application Support/BetterDiscord/plugins`
   - **Linux:** `~/.config/BetterDiscord/plugins`
4. Enable **AutoAckMention** in *Settings → Plugins*.

## Usage

- **Add a channel:** right-click it in the channel list → **Auto-Ack Mentions**.
- **Remove a channel:** *Settings → Plugins → AutoAckMention → ⚙️*, then click **Remove**.

Your channel list is saved automatically and persists across restarts.

## How it works

The plugin subscribes to Discord's `MESSAGE_CREATE` event. When a message lands in one of your target channels and mentions you, it schedules a `CHANNEL_ACK` (the same "mark as read" Discord uses internally) after a random 5–10s delay, clearing the badge.

## Troubleshooting

Set `DEBUG = true` near the top of the plugin file to trace the full flow (module resolution, incoming mentions, scheduled acks) in the console (`Ctrl+Shift+I`). Keep it `false` for normal use.

> **Note:** This plugin relies on Discord's internal modules, which can change between updates. If it stops working after a Discord update, please open an issue.

## License

MIT
