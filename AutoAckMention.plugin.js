/**
 * @name AutoAckMention
 * @description Auto-clear the mention badge from specific channels only.
 * @version 0.6.0
 * @author Priesdelly
 * @authorId 237111626787061760
 * @website https://priesdelly.com
 * @source https://github.com/priesdelly/BD-AutoAckMention/blob/main/AutoAckMention.plugin.js
 */

const PLUGIN_NAME = "AutoAckMention";
const MENU_ID = "channel-context";
const ACK_DELAY_MIN_MS = 5_000;
const ACK_DELAY_MAX_MS = 10_000;

// Flip to true to trace the ack flow in the console; keep false for release.
const LOG_LV_DEBUG = false;
const log = (...a) => LOG_LV_DEBUG && BdApi.Logger.info(PLUGIN_NAME, ...a);

module.exports = class AutoAckMention {
  // Pending ack timers, cleared on stop()
  timers = new Set();

  //When start plugin
  start() {
    this.targetChannelIds = new Set(
      BdApi.Data.load(PLUGIN_NAME, "channels") ?? [],
    );

    this.modules = {
      dispatcher: BdApi.Webpack.getModule(
        (m) => m.dispatch && m.subscribe && m.unsubscribe,
        { searchExports: true },
      ),
      readState: BdApi.Webpack.getModule(
        (m) => m.getMentionCount && m.lastMessageId,
      ),
      user: BdApi.Webpack.getModule((m) => m.getCurrentUser),
      channels: BdApi.Webpack.getStore("ChannelStore"),
      guilds: BdApi.Webpack.getStore("GuildStore"),
      members: BdApi.Webpack.getModule((m) => m.getMember),
      ack: BdApi.Webpack.getModule(
        BdApi.Webpack.Filters.byStrings('"CHANNEL_ACK"'),
        { searchExports: true },
      ),
    };

    log("targets", [...this.targetChannelIds]);
    log(
      "modules",
      Object.fromEntries(
        Object.entries(this.modules).map(([k, v]) => [k, !!v]),
      ),
    );

    if (!this.modules.dispatcher) {
      return BdApi.Logger.error(
        PLUGIN_NAME,
        "Flux dispatcher not found; plugin disabled",
      );
    }

    // Create right click me
    this.menuPatch = BdApi.ContextMenu.patch(MENU_ID, (tree, props) => {
      const channel = props?.channel;
      if (!channel) {
        return;
      }
      tree.props.children.push(
        BdApi.ContextMenu.buildItem({
          type: "toggle",
          label: "Auto-Ack Mentions",
          checked: this.targetChannelIds.has(channel.id),
          action: () => this.toggleChannel(channel.id),
        }),
      );
    });

    // Trigger on when got the message from target channel
    this.onMessage = ({ channelId, message }) => {
      if (!this.targetChannelIds.has(channelId)) {
        return;
      }
      const mention = this.isMention(channelId, message);
      log("MESSAGE_CREATE", { channelId, msgId: message?.id, mention });
      if (mention) {
        this.scheduleAck(channelId);
      }
    };

    //Subscribe for get message
    this.modules.dispatcher.subscribe("MESSAGE_CREATE", this.onMessage);

    this.pruneStaleChannel();
    for (const id of this.targetChannelIds) {
      if (this.checkExisting(id)) this.scheduleAck(id);
    }
    this.doInterval();
    BdApi.Logger.info(PLUGIN_NAME, "started");
  }

  stop() {
    this.menuPatch?.();
    this.modules?.dispatcher?.unsubscribe("MESSAGE_CREATE", this.onMessage);
    clearInterval(this.intervalId);
    this.timers.forEach(clearTimeout);
    this.timers.clear();
    BdApi.Logger.info(PLUGIN_NAME, "stopped");
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

      if (this.targetChannelIds.size === 0) {
        const empty = document.createElement("div");
        empty.textContent = "No channels. Right-click a channel to add one.";
        empty.style.opacity = "0.6";
        return void panel.append(empty);
      }

      for (const id of this.targetChannelIds) {
        const row = document.createElement("div");
        row.style.cssText =
          "display:flex;align-items:center;justify-content:space-between;padding:6px 0";

        const label = document.createElement("span");
        label.textContent = this.describeChannel(id);
        row.append(label);

        const btn = document.createElement("button");
        btn.textContent = "Remove";
        btn.style.cssText =
          "background:var(--button-danger-background,#da373c);color:#fff;border:none;border-radius:4px;padding:4px 10px;cursor:pointer";
        btn.onclick = () => {
          this.toggleChannel(id);
          render();
        };
        row.append(btn);

        panel.append(row);
      }
    };

    this.pruneStaleChannel();
    render();
    return panel;
  }

  doInterval() {
    const tick = () => {
      log("trick interval");
      for (const id of this.targetChannelIds) {
        if (this.checkExisting(id)) this.scheduleAck(id);
      }
    };
    tick();
    this.intervalId = setInterval(tick, 5 * 60 * 1000); //5 min
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
    if (this.targetChannelIds.has(channelId)) {
      log("toggleChannel: remove", channelId);
      this.targetChannelIds.delete(channelId);
    } else {
      log("toggleChannel: add", channelId);
      this.targetChannelIds.add(channelId);
      if (this.checkExisting()) {
        this.scheduleAck(channelId);
      }
    }
    BdApi.Data.save(PLUGIN_NAME, "channels", [...this.targetChannelIds]);
    log("targets updated", [...this.targetChannelIds]);
  }

  // Clear existing stale mentions in target channels on plugin start
  checkExisting() {
    const readState = this.modules.readState;
    if (!readState) {
      return false;
    }

    for (const channelId of this.targetChannelIds) {
      const mentions = readState.getMentionCount?.(channelId) ?? 0;
      log("checkExisting", { channelId, mentions });
      if (mentions > 0) {
        // this.scheduleAck(channelId);
        return true;
      }
    }
    return false;
  }

  // Drop saved channels, If that no longer exist.
  pruneStaleChannel() {
    if (!this.modules.channels?.getChannel) {
      return;
    }
    let changed = false;
    for (const id of this.targetChannelIds) {
      if (!this.modules.channels.getChannel(id)) {
        this.targetChannelIds.delete(id);
        changed = true;
        log("pruned stale channel", id);
      }
    }
    if (changed) {
      BdApi.Data.save(PLUGIN_NAME, "channels", [...this.targetChannelIds]);
    }
  }

  isMention(channelId, message) {
    const myId = this.getMyId();
    if (message.mention_everyone) {
      return true;
    }
    if (message.mentions?.some((u) => u.id === myId)) {
      return true;
    }
    const myRoles = this.getMyRoles(channelId);
    return message.mention_roles?.some((r) => myRoles.includes(r)) ?? false;
  }

  // Schedule an ack after a random 5-10 sec delay (mimic human read timing)
  scheduleAck(channelId) {
    const delay =
      ACK_DELAY_MIN_MS + Math.random() * (ACK_DELAY_MAX_MS - ACK_DELAY_MIN_MS);
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
    return (
      this.modules.members?.getMember?.(guildId, this.getMyId())?.roles ?? []
    );
  }

  ackChannel(channelId) {
    // Skip if nothing left to clear: another device already acked (read state syncs
    const mentionsLeft =
      this.modules.readState?.getMentionCount?.(channelId) ?? 0;
    if (mentionsLeft === 0) {
      return log("skip ack, already read", channelId);
    }

    // Discord's CHANNEL_ACK marks the channel read to latest, clearing the mention badge.
    const ack = this.modules.ack;
    const fn = typeof ack === "function" ? ack : ack?.ack;
    log("acking", {
      channelId,
      mentionsLeft,
      hasAck: typeof fn === "function",
    });
    fn?.(channelId);
  }
};
