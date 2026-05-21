/**
 * voiceHandler.js - Discord ボイスチャンネルの音声受信・処理 (ハイブリッド対応版)
 *
 * ユーザー別の音声ストリームを受信し、PCMに変換してバッファリング後、
 * WebSocketを通じて接続されているローカルPCクライアントへ転送する。
 * DeepL翻訳はクラウド側（ここ）で実行する。APIキーはクラウドの.envに一元管理。
 */

const deepl = require("deepl-node");

const {
  joinVoiceChannel,
  EndBehaviorType,
  VoiceConnectionStatus,
  entersState,
} = require("@discordjs/voice");
const prism = require("prism-media");

// 設定
const BUFFER_DURATION_MS = 3000; // 3秒ごとにバッファをフラッシュ
const SAMPLE_RATE = 48000;
const CHANNELS = 1; // モノラル
const BYTES_PER_SAMPLE = 2; // 16-bit = 2 bytes
const BUFFER_SIZE = SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE * (BUFFER_DURATION_MS / 1000);

// 状態管理
const activeStreams = new Map(); // userId -> { buffer, timer, username }
const knownUsers = new Map(); // userId -> { username, avatarUrl }
let currentConnection = null;
let targetLang = "JA";

// ハイブリッド構成用の状態変数
let activeWsClient = null; // ローカルPC(Transcriberクライアント)のWebSocket
let lastVramError = "";    // 直近 of VRAMエラーメッセージ
const connectedDashboards = new Set(); // 接続されているブラウザダッシュボード

// DeepL 使用量キャッシュ
let cachedUsage = { count: 0, limit: 1000000, percent: "0.0" };

// ダッシュボード用の言語設定
let dashboardTargetLang = "JA";
let dashboardDetectLang = "auto";

// ── DeepL 翻訳 (クラウド側で一元管理) ──
const DEEPL_API_KEY = process.env.DEEPL_API_KEY || "";
let deeplTranslator = null;
if (DEEPL_API_KEY && DEEPL_API_KEY !== "your-deepl-api-key-here") {
  deeplTranslator = new deepl.Translator(DEEPL_API_KEY);
  console.log("✅ [DeepL] クラウド側で DeepL 翻訳エンジンを初期化しました");
  // 起動時に使用状況を取得
  updateUsageCache();
} else {
  console.warn("⚠️ [DeepL] DEEPL_API_KEY が未設定です。翻訳はスキップされ、文字起こしのみ行われます。");
}

/**
 * DeepL の使用状況をキャッシュに更新する
 */
async function updateUsageCache() {
  if (!deeplTranslator) return;
  try {
    const usage = await deeplTranslator.getUsage();
    if (usage.character) {
      const count = usage.character.count;
      const limit = usage.character.limit;
      const percent = ((count / limit) * 100).toFixed(1);
      cachedUsage = { count, limit, percent };
      console.log(`📊 [DeepL Usage] ${count} / ${limit} (${percent}%)`);
    }
  } catch (err) {
    console.error("❌ [DeepL Usage] 取得失敗:", err.message);
  }
}

/**
 * DeepL API でテキストを翻訳する (クラウド側実行)
 */
async function translateWithDeepL(text, targetLang, sourceLang) {
  if (!deeplTranslator || !text || !text.trim()) {
    return { translated_text: "", translation_skipped: true };
  }
  try {
    // 言語コード補正
    let tl = targetLang.toUpperCase();
    if (tl === "EN") tl = "EN-US";
    if (tl === "PT") tl = "PT-BR";

    const result = await deeplTranslator.translateText(
      text,
      sourceLang || null,
      tl
    );
    // 翻訳実行後、使用状況キャッシュをバックグラウンドで更新
    updateUsageCache().catch(() => {});
    return {
      translated_text: result.text,
      detected_source_lang: result.detectedSourceLang,
      translation_skipped: false,
    };
  } catch (err) {
    console.error(`❌ [DeepL] 翻訳エラー: ${err.message}`);
    return { translated_text: `[翻訳エラー: ${err.message}]`, translation_skipped: true };
  }
}

/**
 * ダッシュボード（ブラウザ）のWebSocket接続をハンドリング
 */
function handleDashboardConnection(ws) {
  connectedDashboards.add(ws);
  console.log("💻 [Dashboard] ダッシュボードが接続しました");

  // 初回接続時に現在の言語設定とDeepL使用状況を送る
  ws.send(JSON.stringify({
    type: "init",
    targetLang: dashboardTargetLang,
    detectLang: dashboardDetectLang,
    deeplUsage: cachedUsage
  }));

  ws.on("message", (message) => {
    try {
      const data = JSON.parse(message.toString());
      if (data.type === "change_language" || data.type === "change_target") {
        dashboardTargetLang = data.lang;
        console.log(`🌍 [Dashboard] 翻訳先言語を変更: ${dashboardTargetLang}`);
      } else if (data.type === "change_detect_lang") {
        dashboardDetectLang = data.lang;
        console.log(`🎤 [Dashboard] 検出言語を変更: ${dashboardDetectLang}`);
      }
    } catch (err) {
      console.error("❌ [Dashboard] メッセージ処理エラー:", err);
    }
  });

  ws.on("close", () => {
    connectedDashboards.delete(ws);
    console.log("💻 [Dashboard] ダッシュボードが切断されました");
  });

  ws.on("error", (err) => {
    console.error("❌ [Dashboard] WebSocketエラー:", err);
    connectedDashboards.delete(ws);
  });
}

/**
 * ローカルPC（Transcriberクライアント）のWebSocket接続をハンドリング
 */
function handleHybridConnection(ws) {
  console.log("🔌 [Hybrid] ローカルPCクライアントが接続試行中...");

  ws.on("message", async (message) => {
    try {
      const data = JSON.parse(message.toString());
      
      if (data.type === "register") {
        if (data.vram_status === "ok") {
          activeWsClient = ws;
          lastVramError = "";
          console.log(`✅ [Hybrid] クライアント登録成功 (空きVRAM: ${data.free_vram_gb.toFixed(2)} GB)`);
        } else {
          lastVramError = data.error_message || "不明なVRAMエラー";
          console.error(`🚨 [Hybrid] クライアント登録失敗 (VRAM不足): ${lastVramError}`);
          ws.close();
        }
      } 
      
      else if (data.type === "transcription_result") {
        // 文字起こし結果を受信 → クラウド側でDeepL翻訳 → ダッシュボードへブロードキャスト
        const originalText = data.original_text || "";
        const detectedLang = data.detected_language || "auto";

        // ── 雑音・ハルシネーション（幻聴ノイズ）フィルタ ──
        const normalized = originalText.toLowerCase().replace(/[.,\/#!$%\^&\*;:{}=\-_`~()?]/g, "").trim();
        const hallucinationList = ["yeah", "okay", "hmm", "uh", "um", "oh", "ah", "yep", "ding ding ding"];
        if (hallucinationList.includes(normalized) && normalized.length <= 15) {
          console.log(`🔇 [Hallucination Filtered] Ignored noise/short feedback: "${originalText}"`);
          return; // 完全に無視してダッシュボードやDiscord送信を行わない
        }

        console.log(`🎤 [Hybrid] [${data.username}] ${originalText} (${detectedLang})`);

        // DeepL翻訳をクラウド側で実行
        const currentTargetLang = dashboardTargetLang || targetLang;
        const tlResult = await translateWithDeepL(originalText, currentTargetLang, null);

        if (tlResult.translated_text && !tlResult.translation_skipped) {
          console.log(`   🌐 [DeepL] -> [${currentTargetLang}] ${tlResult.translated_text}`);
        }

        broadcastToDashboards({
          type: "transcription",
          user_id: data.user_id,
          username: data.username,
          avatar_url: data.avatar_url,
          original_text: originalText,
          detected_language: detectedLang,
          translated_text: tlResult.translated_text,
          target_lang: currentTargetLang,
          translation_skipped: tlResult.translation_skipped,
          deepl_usage: cachedUsage,
          timestamp: data.timestamp || new Date().toLocaleTimeString("ja-JP")
        });
      }
    } catch (err) {
      console.error("❌ [Hybrid] メッセージ処理エラー:", err);
    }
  });

  ws.on("close", () => {
    console.log("🔌 [Hybrid] ローカルPCクライアントが切断されました。");
    if (activeWsClient === ws) {
      activeWsClient = null;
    }
  });

  ws.on("error", (err) => {
    console.error("❌ [Hybrid] クライアントエラー:", err);
    if (activeWsClient === ws) {
      activeWsClient = null;
    }
  });
}

/**
 * すべてのダッシュボードにブロードキャスト
 */
function broadcastToDashboards(data) {
  const json = JSON.stringify(data);
  for (const ws of connectedDashboards) {
    if (ws.readyState === 1) { // OPEN
      ws.send(json);
    }
  }
}

/**
 * アクティブクライアント接続の有無を確認
 */
function hasActiveClient() {
  return activeWsClient !== null;
}

/**
 * 直近のVRAMエラーを取得
 */
function getLastVramError() {
  return lastVramError;
}

/**
 * ボイスチャンネルに参加
 */
async function joinChannel(channel, _transcriberUrl, _targetLang) {
  targetLang = _targetLang;

  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: true,
  });

  connection.on('stateChange', (oldState, newState) => {
    console.log(`🔄 Voice Connection: ${oldState.status} -> ${newState.status}`);
  });

  connection.on('error', (error) => {
    console.error('❌ Voice Connection Error:', error);
  });

  // Windows UDP KeepAlive Fix
  const networkStateChangeHandler = (oldNetworkState, newNetworkState) => {
    const newUdp = Reflect.get(newNetworkState, 'udp');
    clearInterval(newUdp?.keepAliveInterval);
  };
  connection.on('stateChange', (oldState, newState) => {
    const oldNetworking = Reflect.get(oldState, 'networking');
    const newNetworking = Reflect.get(newState, 'networking');
    oldNetworking?.off('stateChange', networkStateChangeHandler);
    newNetworking?.on('stateChange', networkStateChangeHandler);
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    console.log(`✅ ボイスチャンネルに参加: #${channel.name}`);
  } catch (error) {
    console.error("❌ ボイスチャンネルへの接続に失敗:", error);
    connection.destroy();
    throw error;
  }

  currentConnection = connection;

  // ユーザーが話し始めたら自動でリスニング開始
  connection.receiver.speaking.on("start", (userId) => {
    const state = activeStreams.get(userId);
    if (!state || !state.isListening) {
      startListening(connection, userId);
    }
  });

  return connection;
}

/**
 * ボイスチャンネルから退出
 */
function leaveChannel() {
  for (const [userId, stream] of activeStreams) {
    clearInterval(stream.timer);
  }
  activeStreams.clear();

  if (currentConnection) {
    currentConnection.destroy();
    currentConnection = null;
    console.log("👋 ボイスチャンネルから退出しました");
  }
}

/**
 * 特定ユーザーの音声リスニングを開始
 */
function startListening(connection, userId) {
  const opusStream = connection.receiver.subscribe(userId, {
    end: {
      behavior: EndBehaviorType.AfterSilence,
      duration: 500, // 0.5秒の沈黙でストリーム終了
    },
  });

  const decoder = new prism.opus.Decoder({
    rate: SAMPLE_RATE,
    channels: CHANNELS,
    frameSize: 960,
  });

  if (!activeStreams.has(userId)) {
    activeStreams.set(userId, {
      buffer: Buffer.alloc(0),
      lastSendTime: 0,
      flushTimer: null,
      isListening: false,
      username: knownUsers.get(userId)?.username || `User_${userId.slice(-4)}`,
      avatarUrl: knownUsers.get(userId)?.avatarUrl || "",
    });
  }

  const state = activeStreams.get(userId);
  state.isListening = true;

  if (state.flushTimer) {
    clearTimeout(state.flushTimer);
    state.flushTimer = null;
  }

  const pcmStream = opusStream.pipe(decoder);

  pcmStream.on("data", (chunk) => {
    state.buffer = Buffer.concat([state.buffer, chunk]);
  });

  pcmStream.on("end", () => {
    state.isListening = false;
    if (state.buffer.length > 0) {
      flushBuffer(userId);
    }
  });

  pcmStream.on("error", (error) => {
    state.isListening = false;
    console.error(`❌ 音声デコードエラー (${userId}):`, error.message);
  });
}

/**
 * バッファをフラッシュしてローカルPCクライアントに送信
 */
async function flushBuffer(userId) {
  const stream = activeStreams.get(userId);
  if (!stream || stream.buffer.length === 0) return;

  if (!activeWsClient) {
    console.error("❌ [Hybrid] 送信エラー: 接続中のローカルPCクライアントがありません！");
    stream.buffer = Buffer.alloc(0);
    return;
  }

  const audioBuffer = Buffer.from(stream.buffer);
  stream.buffer = Buffer.alloc(0);
  stream.lastSendTime = Date.now();
  stream.flushTimer = null;

  // 音声データが短すぎる場合はスキップ（雑音・ハルシネーション対策：0.8秒未満は無視）
  // 48000Hz * 2 bytes * 0.8s = 76800 bytes
  if (audioBuffer.length < 76800) {
    return;
  }

  const audioBase64 = audioBuffer.toString("base64");

  try {
    activeWsClient.send(JSON.stringify({
      type: "transcribe_request",
      audio_base64: audioBase64,
      user_id: userId,
      username: stream.username,
      avatar_url: stream.avatarUrl || "",
      sample_rate: SAMPLE_RATE,
      channels: CHANNELS,
      target_lang: dashboardTargetLang || targetLang,
      detect_lang: dashboardDetectLang
    }));
  } catch (error) {
    console.error(`❌ [Hybrid] クライアントへの音声送信に失敗: ${error.message}`);
  }
}

/**
 * ユーザー情報を更新する
 */
function updateUserInfo(userId, username, avatarUrl) {
  knownUsers.set(userId, { username, avatarUrl: avatarUrl || "" });
  const stream = activeStreams.get(userId);
  if (stream) {
    stream.username = username;
    stream.avatarUrl = avatarUrl || "";
  }
}

/**
 * 翻訳先言語を変更する
 */
function setTargetLanguage(lang) {
  dashboardTargetLang = lang;
  console.log(`🌐 翻訳先言語を変更: ${lang}`);
}

/**
 * 現在の接続状態を取得
 */
function getStatus() {
  return {
    connected: currentConnection !== null,
    activeStreams: activeStreams.size,
    targetLang: dashboardTargetLang || targetLang,
    hasClient: activeWsClient !== null,
    deeplUsage: cachedUsage
  };
}

module.exports = {
  joinChannel,
  leaveChannel,
  updateUserInfo,
  setTargetLanguage,
  getStatus,
  handleDashboardConnection,
  handleHybridConnection,
  hasActiveClient,
  getLastVramError,
};
