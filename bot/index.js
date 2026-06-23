/**
 * index.js - Discord Bot メインエントリーポイント (ハイブリッド構成対応)
 *
 * Discord Botの起動、スラッシュコマンドの登録、
 * Express サーバーと WebSocket サーバーを単一ポートで起動する。
 */

require("dotenv").config();
const dns = require("node:dns");
dns.setDefaultResultOrder("ipv4first"); // Node 17+ の IPv6 解決バグ対策

const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, MessageFlags } = require("discord.js");
const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const path = require("path");
const voiceHandler = require("./voiceHandler");

// ── 設定 ──
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
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
          flags: MessageFlags.Ephemeral,
      });
    }

    // ── Botに必要なすべての音声権限リストの事前チェック ──
    const requiredPermissions = [
      { key: "ViewChannel", label: "チャンネルを見る (View Channel)", desc: "チャンネルを閲覧・表示するために必要です 【必須】" },
      { key: "Connect", label: "接続 (Connect)", desc: "ボイスチャンネルに参加するために必要です 【必須】" },
      { key: "Speak", label: "発言 (Speak)", desc: "音声送信を行わないミュート参加であっても、Discord APIとの接続接続確立に必要です 【必須】" },
      { key: "UseVAD", label: "音声検出を使用 (Use Voice Activity)", desc: "メンバーの発言を正常に検知し、文字起こしするために必要です 【必須】" }
    ];

    // 複数の判定方法でフォールバックしながら確実に権限を取得する (Discord.jsのキャッシュバグ対策)
    const meMember = voiceChannel.guild.members.me;
    const permissions = voiceChannel.permissionsFor(client.user.id) || (meMember ? voiceChannel.permissionsFor(meMember) : null) || voiceChannel.permissionsFor(client.user);

    // コマンドプロンプトに詳細な判定内訳を出力して原因を可視化する
    console.log(`\n=== 🔍 [Hirom_room] ボイス接続 権限判定デバッグログ ===`);
    console.log(`Bot ID: ${client.user.id}`);
    console.log(`GuildMember Me (Botのキャッシュ): ${meMember ? "取得成功" : "取得失敗"}`);
    console.log(`解決したPermissionsオブジェクト: ${permissions ? "存在します (正常)" : "存在しません (NULL)"}`);
    if (permissions) {
      console.log(`• チャンネルを見る (ViewChannel) = ${permissions.has("ViewChannel")}`);
      console.log(`• 接続 (Connect) = ${permissions.has("Connect")}`);
      console.log(`• 発言 (Speak) = ${permissions.has("Speak")}`);
      console.log(`• 音声検出 (UseVAD) = ${permissions.has("UseVAD")}`);
    }
    console.log(`====================================================\n`);

    const missingPermissions = [];

    if (!permissions) {
      missingPermissions.push(...requiredPermissions);
    } else {
      for (const p of requiredPermissions) {
        // [Discord仕様対策] ViewChannelがfalseでも、Connect(接続)がtrueであれば、
        // 実際にはBotがチャンネルを検知してコマンド応答できているため、接続を許可（フォールバック）する
        if (p.key === "ViewChannel") {
          if (!permissions.has("ViewChannel") && !permissions.has("Connect")) {
            missingPermissions.push(p);
          } else if (!permissions.has("ViewChannel") && permissions.has("Connect")) {
            console.log(`⚠️ [Hirom_room] ViewChannelがfalseですが、Connectがtrueのためフォールバック接続を試みます。`);
          }
        } else {
          if (!permissions.has(p.key)) {
            missingPermissions.push(p);
          }
        }
      }
    }

    if (missingPermissions.length > 0) {
      let errContent = `❌ **Botの必要な権限が不足しているため、ボイスチャンネルに参加できません。**\n\n`;
      errContent += `ボイスチャンネル **#${voiceChannel.name}** の「チャンネルの編集」＞「権限」にて、**Botロール** または **@everyone** に対して以下の権限を **許可（緑のチェックマーク）** に設定してください。\n\n`;
      
      missingPermissions.forEach(p => {
        errContent += `* ❌ **[未許可]** **${p.label}**\n  └ *${p.desc}*\n`;
      });
      
      errContent += `\n※現在「チャンネルを見る」と「接続」が許可されていても、「発言」や「音声検出を使用」が許可されていないとDiscord APIにより接続が拒否されることがあります。`;

      return interaction.reply({
        content: errContent,
        flags: MessageFlags.Ephemeral
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
      const permissions = voiceChannel.permissionsFor(voiceChannel.guild.members.me);
      let errMsg = `❌ **ボイスチャンネルへの参加に失敗しました。**\n`;
      errMsg += `エラー内容: \`${error.message}\`\n\n`;
      errMsg += `**📢 Discordの音声チャンネル接続に必要なBot権限チェックリスト:**\n`;
      
      const checkPerm = (key, label) => {
        const has = permissions && permissions.has(key);
        return `${has ? "✅" : "❌ [未許可・設定してください]"} **${label}**`;
      };

      errMsg += `• ${checkPerm("ViewChannel", "チャンネルを見る (View Channel)")}\n`;
      errMsg += `• ${checkPerm("Connect", "接続 (Connect)")}\n`;
      errMsg += `• ${checkPerm("Speak", "発言 (Speak)")}\n`;
      errMsg += `• ${checkPerm("UseVAD", "音声検出を使用 (Use Voice Activity)")}\n\n`;
      errMsg += `※ボイスチャンネル **#${voiceChannel.name}** の「チャンネルの編集」＞「権限」から、**Bot（またはBotのロール）**に対して上記4つの権限がすべて「許可（緑のチェック）」になっているか再度ご確認ください。`;

      await interaction.editReply(errMsg);
    }
  }

  // /leave コマンド
  if (commandName === "leave") {
    await voiceHandler.leaveChannel(interaction.channel);
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
    statusText += `翻訳モード: ☁️ Gemini 3.5 クラウド翻訳\n`;
    statusText += `アクティブストリーム: ${status.activeStreams}\n`;
    statusText += `翻訳先言語: ${status.targetLang}\n`;
    statusText += `ダッシュボード: ${DASHBOARD_URL}`;

    await interaction.reply({ content: statusText, flags: MessageFlags.Ephemeral });
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

    let targetChannel = null;
    for (const [, guild] of client.guilds.cache) {
      for (const [, channel] of guild.channels.cache) {
        if (channel.type === 2 && channel.members.size > 0) {
          const hasHuman = channel.members.some((m) => !m.user.bot);
          if (hasHuman) {
            // Bot自身に表示（ViewChannel）および接続（Connect）の権限があるかチェック
            const permissions = channel.permissionsFor(channel.guild.members.me);
            if (permissions && permissions.has("Connect")) {
              targetChannel = channel;
              break;
            }
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

// HTTPアップグレードリクエストを振り分ける
server.on("upgrade", (request, socket, head) => {
  // パス名を取得
  const urlObj = new URL(request.url, `http://${request.headers.host}`);
  const pathname = urlObj.pathname;

  if (pathname === "/ws") {
    wssDashboard.handleUpgrade(request, socket, head, (ws) => {
      wssDashboard.emit("connection", ws, request);
    });
  } else {
    socket.destroy();
  }
});

// 単一ポートで起動 (Express + WebSocket)
server.listen(DASHBOARD_PORT, () => {
  console.log(`📊 ダッシュボード ＆ WebSocket サーバー起動完了！`);
  console.log(`🔗 Webダッシュボード: http://localhost:${DASHBOARD_PORT}`);
  
  // localtunnel をバックグラウンドで自動起動
  voiceHandler.startTunnel();
});

// ── Discordテキストチャンネルのチャット監視 ＆ リアルタイム翻訳 ──
client.on("messageCreate", async (message) => {
  // Bot自身のメッセージや他のBotのメッセージは無視
  if (message.author.bot) return;

  // Botが現在参加しているアクティブなテキストチャンネル以外のメッセージは完全に無視する
  const activeTextChannelId = voiceHandler.getActiveTextChannelId();
  if (!activeTextChannelId || message.channel.id !== activeTextChannelId) return;

  // テキストメッセージの内容を取得して翻訳
  const text = message.content;
  if (!text || !text.trim()) return;

  console.log(`💬 [Discord Chat] [${message.author.username}] ${text}`);

  try {
    // 接続されているダッシュボードごとに個別翻訳して配信する
    await voiceHandler.handleDiscordChatMessage(
      message.member?.displayName || message.author.username,
      message.author.displayAvatarURL({ size: 64, extension: "png" }) || "",
      text
    );
  } catch (err) {
    console.error("❌ [Discord Chat] 処理または個別配信に失敗:", err.message);
  }
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

