/**
 * index.js - Discord Bot メインエントリーポイント (ハイブリッド構成対応)
 *
 * Discord Botの起動、スラッシュコマンドの登録、
 * Express サーバーと WebSocket サーバーを単一ポートで起動する。
 */

require("dotenv").config();
const dns = require("node:dns");
dns.setDefaultResultOrder("ipv4first"); // Node 17+ の IPv6 解決バグ対策

const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require("discord.js");
const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const path = require("path");
const voiceHandler = require("./voiceHandler");

// ── 設定 ──
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const HYBRID_WS_PORT = parseInt(process.env.HYBRID_WS_PORT || "8765", 10);
const DASHBOARD_PORT = parseInt(process.env.DASHBOARD_PORT || "3000", 10);
const DASHBOARD_URL = process.env.DASHBOARD_URL || `http://localhost:${DASHBOARD_PORT}`;
const DEFAULT_TARGET_LANG = process.env.DEFAULT_TARGET_LANG || "JA";

if (!DISCORD_TOKEN || DISCORD_TOKEN === "your-bot-token-here") {
  console.error("❌ DISCORD_TOKEN が設定されていません！");
  console.error("   bot/.env ファイルを編集して、Botトークンを貼り付けてください。");
  process.exit(1);
}

// ── Discord クライアント ──
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// ── スラッシュコマンド定義 ──
const commands = [
  new SlashCommandBuilder()
    .setName("join")
    .setDescription("Botをあなたのボイスチャンネルに参加させます"),
  new SlashCommandBuilder()
    .setName("leave")
    .setDescription("Botをボイスチャンネルから退出させます"),
  new SlashCommandBuilder()
    .setName("lang")
    .setDescription("翻訳先言語を変更します")
    .addStringOption((option) =>
      option
        .setName("language")
        .setDescription("翻訳先の言語コード")
        .setRequired(true)
        .addChoices(
          { name: "日本語", value: "JA" },
          { name: "英語 (US)", value: "EN-US" },
          { name: "韓国語", value: "KO" },
          { name: "中国語 (簡体)", value: "ZH-HANS" },
          { name: "インドネシア語", value: "ID" },
          { name: "スペイン語", value: "ES" },
          { name: "フランス語", value: "FR" },
          { name: "ドイツ語", value: "DE" }
        )
    ),
  new SlashCommandBuilder()
    .setName("status")
    .setDescription("Bot の現在のステータスを表示します"),
];

// ── Bot起動 ──
client.once("ready", async () => {
  console.log(`✅ Discord Bot ログイン成功: ${client.user.tag}`);

  // スラッシュコマンドを登録
  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
  try {
    await rest.put(Routes.applicationCommands(client.user.id), {
      body: commands.map((cmd) => cmd.toJSON()),
    });
    console.log("✅ スラッシュコマンド登録完了: /join, /leave, /lang, /status");
  } catch (error) {
    console.error("❌ スラッシュコマンド登録エラー:", error);
  }
});

// ── スラッシュコマンド処理 ──
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;

  // /join コマンド
  if (commandName === "join") {
    const voiceChannel = interaction.member?.voice?.channel;
    if (!voiceChannel) {
      return interaction.reply({
        content: "❌ まずボイスチャンネルに参加してください！",
        ephemeral: true,
      });
    }

    // ★重要: ローカルPCクライアント（GPU側）が接続されているかチェック
    if (!voiceHandler.hasActiveClient()) {
      const vramErr = voiceHandler.getLastVramError();
      let errorMsg = "⚠️ **GPUクライアントが未接続です。**\n\n";
      if (vramErr) {
        errorMsg += `🚨 **前回のエラー**: \`${vramErr}\`\n\n`;
      }
      errorMsg += "📥 **手順（初回のみ）**\n";
      errorMsg += "1. GitHubリポジトリからコードをダウンロード\n";
      errorMsg += "2. `start-client.bat` をダブルクリックして起動\n";
      errorMsg += "3. 「スタンバイOK」と表示されたら、もう一度 `/join` を実行\n\n";
      errorMsg += `📊 ダッシュボード: ${DASHBOARD_URL}`;

      return interaction.reply({
        content: errorMsg,
        ephemeral: false
      });
    }

    await interaction.deferReply();

    try {
      await voiceHandler.joinChannel(voiceChannel, interaction.channel, DEFAULT_TARGET_LANG);

      // チャンネル内のメンバーのユーザー情報を設定
      for (const [memberId, member] of voiceChannel.members) {
        voiceHandler.updateUserInfo(
          memberId,
          member.displayName,
          member.displayAvatarURL({ size: 64, extension: "png" })
        );
      }

      await interaction.editReply(
        `✅ **#${voiceChannel.name}** に参加しました！\n` +
          `📊 ダッシュボード: ${DASHBOARD_URL}\n` +
          `🌐 翻訳先言語: ${DEFAULT_TARGET_LANG}`
      );
    } catch (error) {
      await interaction.editReply(`❌ 参加に失敗しました: ${error.message}`);
    }
  }

  // /leave コマンド
  if (commandName === "leave") {
    voiceHandler.leaveChannel();
    await interaction.reply("👋 ボイスチャンネルから退出しました。");
  }

  // /lang コマンド
  if (commandName === "lang") {
    const lang = interaction.options.getString("language");
    voiceHandler.setTargetLanguage(lang);
    await interaction.reply(`🌐 翻訳先言語を **${lang}** に変更しました。`);
  }

  // /status コマンド
  if (commandName === "status") {
    const status = voiceHandler.getStatus();
    let statusText = "📊 **Bot ステータス**\n";
    statusText += `接続状態: ${status.connected ? "✅ 接続中" : "❌ 未接続"}\n`;
    statusText += `ローカルGPUクライアント: ${status.hasClient ? "✅ 接続完了 (準備OK)" : "❌ 未接続 (起動してください)"}\n`;
    statusText += `アクティブストリーム: ${status.activeStreams}\n`;
    statusText += `翻訳先言語: ${status.targetLang}\n`;
    statusText += `ダッシュボード: ${DASHBOARD_URL}`;

    await interaction.reply({ content: statusText, ephemeral: true });
  }
});

// ── ボイスチャンネルのメンバー変更を監視 ──
client.on("voiceStateUpdate", (oldState, newState) => {
  if (newState.channel && newState.member) {
    voiceHandler.updateUserInfo(
      newState.id,
      newState.member.displayName,
      newState.member.displayAvatarURL({ size: 64, extension: "png" })
    );
  }

  // Botの参加チャンネルへのメンバー出入りを追跡
  const botChannelId = voiceHandler.getCurrentChannelId();
  if (!botChannelId) return;

  const memberId = newState.id || oldState.id;
  const member = newState.member || oldState.member;
  if (!member || member.user.bot) return;

  // メンバーがBotのチャンネルに参加した
  if (newState.channelId === botChannelId && oldState.channelId !== botChannelId) {
    voiceHandler.addVoiceMember(
      memberId,
      member.displayName,
      member.displayAvatarURL({ size: 64, extension: "png" })
    );
  }

  // メンバーがBotのチャンネルから退出した
  if (oldState.channelId === botChannelId && newState.channelId !== botChannelId) {
    voiceHandler.removeVoiceMember(memberId);
  }
});

// ── Express: ダッシュボード配信 ──
const app = express();
const dashboardPath = path.join(__dirname, "..", "dashboard");
app.use(express.static(dashboardPath));

app.get("/", (req, res) => {
  res.sendFile(path.join(dashboardPath, "index.html"));
});

app.use(express.json());

app.post("/api/join", async (req, res) => {
  try {
    if (!voiceHandler.hasActiveClient()) {
      return res.json({ ok: false, error: "文字起こしクライアントが接続されていません。ローカルクライアントを起動してください。" });
    }

    let targetChannel = null;
    for (const [, guild] of client.guilds.cache) {
      for (const [, channel] of guild.channels.cache) {
        if (channel.type === 2 && channel.members.size > 0) {
          const hasHuman = channel.members.some((m) => !m.user.bot);
          if (hasHuman) {
            targetChannel = channel;
            break;
          }
        }
      }
      if (targetChannel) break;
    }

    if (!targetChannel) {
      return res.json({ ok: false, error: "ボイスチャンネルにユーザーがいません。先にDiscordのボイスチャンネルに参加してください。" });
    }

    // ギルド内でBotがアクセス可能な最初のテキストチャンネル（0 = GuildText）を検出して渡す
    const textChannel = targetChannel.guild.channels.cache.find((c) => c.type === 0);
    await voiceHandler.joinChannel(targetChannel, textChannel, DEFAULT_TARGET_LANG);

    for (const [memberId, member] of targetChannel.members) {
      voiceHandler.updateUserInfo(
        memberId,
        member.displayName,
        member.displayAvatarURL({ size: 64, extension: "png" })
      );
    }

    res.json({ ok: true, channel: targetChannel.name, guild: targetChannel.guild.name });
    console.log(`✅ ダッシュボードからボイスチャンネルに参加: #${targetChannel.name}`);
  } catch (error) {
    res.json({ ok: false, error: error.message });
  }
});

app.post("/api/leave", (req, res) => {
  // リクエストが localhost (ループバック) からのものかチェック
  const ip = req.ip || req.socket.remoteAddress;
  const isLocal = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  
  if (!isLocal) {
    console.warn(`⚠️ [Security Alert] 外部IP (${ip}) からのBot退出要求をブロックしました。`);
    return res.status(403).json({ ok: false, error: "アクセス権限がありません。Botの退出はホストPCからのみ実行可能です。" });
  }

  voiceHandler.leaveChannel();
  res.json({ ok: true });
  console.log("👋 ダッシュボードからボイスチャンネルを退出");
});

app.get("/api/status", (req, res) => {
  res.json(voiceHandler.getStatus());
});

// ── HTTP & WebSocket サーバーの統合 ──
const server = http.createServer(app);

// 1. ダッシュボード用WebSocketサーバー (/ws)
const wssDashboard = new WebSocketServer({ noServer: true });
wssDashboard.on("connection", (ws) => {
  voiceHandler.handleDashboardConnection(ws);
});

// 2. ハイブリッドPCクライアント用WebSocketサーバー (/hybrid)
const wssHybrid = new WebSocketServer({ noServer: true });
wssHybrid.on("connection", (ws) => {
  voiceHandler.handleHybridConnection(ws);
});

// HTTPアップグレードリクエストを振り分ける
server.on("upgrade", (request, socket, head) => {
  // パス名を取得
  const urlObj = new URL(request.url, `http://${request.headers.host}`);
  const pathname = urlObj.pathname;

  if (pathname === "/ws") {
    wssDashboard.handleUpgrade(request, socket, head, (ws) => {
      wssDashboard.emit("connection", ws, request);
    });
  } else if (pathname === "/hybrid") {
    wssHybrid.handleUpgrade(request, socket, head, (ws) => {
      wssHybrid.emit("connection", ws, request);
    });
  } else {
    socket.destroy();
  }
});

// 単一ポートで起動 (Express + WebSocket)
server.listen(DASHBOARD_PORT, () => {
  console.log(`📊 ダッシュボード ＆ WebSocket サーバー起動完了！`);
  console.log(`🔗 Webダッシュボード: http://localhost:${DASHBOARD_PORT}`);
  console.log(`🔌 ローカルPC接続用WebSocket: ws://localhost:${DASHBOARD_PORT}/hybrid`);
  
  // localtunnel をバックグラウンドで自動起動
  voiceHandler.startTunnel();
});

// ── Botログイン ──
client.login(DISCORD_TOKEN).catch((error) => {
  console.log("❌ Discord Botのログインに失敗しました:", error.message);
  console.log("   bot/.env の DISCORD_TOKEN を確認してください。");
  process.exit(1);
});

// ── プロセス終了時のクリーンアップ (Botの迅速な退出) ──
const cleanup = () => {
  console.log("🧹 終了シグナルを検知しました。Botを退出させます...");
  try {
    voiceHandler.leaveChannel();
  } catch (e) {
    console.error("❌ 終了時の退出処理に失敗:", e);
  }
  process.exit(0);
};

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);
process.on("SIGBREAK", cleanup); // Windowsのcmd.exe用
process.on("SIGHUP", cleanup);   // ターミナル切断用

