/**
 * @name AutoAckMention
 * @description Auto-clear the mention badge from specific channels only.
 * @version 0.6.0
 * @author Priesdelly
 * @authorId 237111626787061760
 * @website https://priesdelly.com
 * @source https://github.com/priesdelly/BD-AutoAckMention/blob/main/AutoAckMention.plugin.js
 */

const NAME = "AutoAckMention";
const MENU_ID = "channel-context";
const ACK_DELAY_MIN_MS = 5_000;
const ACK_DELAY_MAX_MS = 10_000;

// Flip to true to trace the ack flow in the console; keep false for release.
const DEBUG = false;
const log = (...a) => DEBUG && BdApi.Logger.info(NAME, ...a);

module.exports = class AutoAckMention {
  // Pending ack timers, cleared on stop()
  timers = new Set();

  start() {
    this.targets = new Set(BdApi.Data.load(NAME, "channels") ?? []);

    this.modules = {
      dispatcher: BdApi.Webpack.getModule(m => m.dispatch && m.subscribe && m.unsubscribe, { searchExports: true }),
      readState: BdApi.Webpack.getModule(m => m.getMentionCount && m.lastMessageId),
      user: BdApi.Webpack.getModule(m => m.getCurrentUser),
      channels: BdApi.Webpack.getStore("ChannelStore"),
      guilds: BdApi.Webpack.getStore("GuildStore"),
      members: BdApi.Webpack.getModule(m => m.getMember),
      ack: BdApi.Webpack.getModule(BdApi.Webpack.Filters.byStrings('"CHANNEL_ACK"'), { searchExports: true }),
    };

    log("targets", [...this.targets]);
    log("modules", Object.fromEntries(Object.entries(this.modules).map(([k, v]) => [k, !!v])));

    if (!this.modules.dispatcher) {
      return BdApi.Logger.error(NAME, "Flux dispatcher not found; plugin disabled");
    }

    this.menuPatch = BdApi.ContextMenu.patch(MENU_ID, (tree, props) => {
      const channel = props?.channel;
      if (!channel) return;
      tree.props.children.push(BdApi.ContextMenu.buildItem({
        type: "toggle",
        label: "Auto-Ack Mentions",
        checked: this.targets.has(channel.id),
        action: () => this.toggleChannel(channel.id),
      }));
    });

    this.onMessage = ({ channelId, message }) => {
      if (!this.targets.has(channelId)) return;
      const mention = this.isMention(channelId, message);
      log("MESSAGE_CREATE", { channelId, msgId: message?.id, mention });
      if (mention) this.scheduleAck(channelId);
    };
    this.modules.dispatcher.subscribe("MESSAGE_CREATE", this.onMessage);

    this.pruneStale();
    this.checkExisting();
    BdApi.Logger.info(NAME, "started");
  }

  stop() {
    this.menuPatch?.();
    this.modules?.dispatcher?.unsubscribe("MESSAGE_CREATE", this.onMessage);
    this.timers.forEach(clearTimeout);
    this.timers.clear();
    BdApi.Logger.info(NAME, "stopped");
  }

  // Settings panel: list current channels, each with a button to remove it
  getSettingsPanel() {
    const panel = document.createElement("div");
    panel.style.cssText = "padding:16px;color:var(--text-normal)";

    const render = () => {
      panel.innerHTML = "";
      const title = document.createElement("h3");
      title.textContent = "Auto-Ack Channels";
      title.style.cssText = "margin:0 0 8px;font-weight:600";
      panel.append(title);

      if (this.targets.size === 0) {
        const empty = document.createElement("div");
        empty.textContent = "No channels. Right-click a channel to add one.";
        empty.style.opacity = "0.6";
        return void panel.append(empty);
      }

      for (const id of this.targets) {
        const row = document.createElement("div");
        row.style.cssText = "display:flex;align-items:center;justify-content:space-between;padding:6px 0";

        const label = document.createElement("span");
        label.textContent = this.describeChannel(id);
        row.append(label);

        const btn = document.createElement("button");
        btn.textContent = "Remove";
        btn.style.cssText = "background:var(--button-danger-background,#da373c);color:#fff;border:none;border-radius:4px;padding:4px 10px;cursor:pointer";
        btn.onclick = () => { this.toggleChannel(id); render(); };
        row.append(btn);

        panel.append(row);
      }
    };

    this.pruneStale();
    render();
    return panel;
  }

  // "Server > channel (id)", falling back to "channel (id)" outside a guild
  describeChannel(channelId) {
    const channel = this.modules.channels?.getChannel?.(channelId);
    const channelName = channel?.name ?? channelId;
    const serverName = this.modules.guilds?.getGuild?.(channel?.guild_id)?.name;
    return serverName
      ? `${serverName} > ${channelName} (${channelId})`
      : `${channelName} (${channelId})`;
  }

  // Add/remove a channel from the persisted target list
  toggleChannel(channelId) {
    if (this.targets.has(channelId)) this.targets.delete(channelId);
    else this.targets.add(channelId);
    BdApi.Data.save(NAME, "channels", [...this.targets]);
    log("targets updated", [...this.targets]);
  }

  // Clear existing stale mentions in target channels on plugin start
  checkExisting() {
    const readState = this.modules.readState;
    if (!readState) return;

    for (const channelId of this.targets) {
      const mentions = readState.getMentionCount?.(channelId) ?? 0;
      log("existing", { channelId, mentions });
      if (mentions > 0) this.scheduleAck(channelId);
    }
  }

  // Drop saved channels that no longer exist (deleted, left guild/DM).
  // Bails if ChannelStore is unavailable so a failed lookup never wipes the list.
  // ponytail: an archived/unloaded thread reads as gone too; rare, accept it.
  pruneStale() {
    if (!this.modules.channels?.getChannel) return;
    let changed = false;
    for (const id of this.targets) {
      if (!this.modules.channels.getChannel(id)) {
        this.targets.delete(id);
        changed = true;
        log("pruned stale channel", id);
      }
    }
    if (changed) BdApi.Data.save(NAME, "channels", [...this.targets]);
  }

  isMention(channelId, message) {
    const myId = this.getMyId();
    if (message.mention_everyone) return true;
    if (message.mentions?.some(u => u.id === myId)) return true;
    const myRoles = this.getMyRoles(channelId);
    return message.mention_roles?.some(r => myRoles.includes(r)) ?? false;
  }

  // Schedule an ack after a random 5-10 sec delay (mimic human read timing)
  scheduleAck(channelId) {
    const delay = ACK_DELAY_MIN_MS + Math.random() * (ACK_DELAY_MAX_MS - ACK_DELAY_MIN_MS);
    log(`scheduling ack for ${channelId} in ${Math.round(delay / 1000)}s`);
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      this.ackChannel(channelId);
    }, delay);
    this.timers.add(timer);
  }

  getMyId() {
    return this.modules.user?.getCurrentUser()?.id;
  }

  getMyRoles(channelId) {
    const guildId = this.modules.channels?.getChannel?.(channelId)?.guild_id;
    return this.modules.members?.getMember?.(guildId, this.getMyId())?.roles ?? [];
  }

  ackChannel(channelId) {
    // Skip if nothing left to clear: another device already acked (read state syncs
    // across sessions) or the channel was read manually during the delay. Avoids the
    // redundant ack on an already-read channel that can look like self-bot activity.
    const mentionsLeft = this.modules.readState?.getMentionCount?.(channelId) ?? 0;
    if (mentionsLeft === 0) return log("skip ack, already read", channelId);

    // Discord's CHANNEL_ACK marks the channel read to latest, clearing the mention badge.
    // Resolved by source string, so it may be the function itself or a module exposing .ack.
    const ack = this.modules.ack;
    const fn = typeof ack === "function" ? ack : ack?.ack;
    log("acking", { channelId, mentionsLeft, hasAck: typeof fn === "function" });
    fn?.(channelId);
  }
};
