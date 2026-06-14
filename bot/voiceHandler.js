/**
 * voiceHandler.js - Discord ボイスチャンネルの音声受信・処理 (マルチモデル・各自DeepL対応・完全安定版)
 *
 * ユーザー別の音声ストリームを受信し、PCMに変換してバッファリング後、
 * WebSocketを通じて接続されているローカルPCクライアントへ転送する。
 * 翻訳は完全ローカルWebSocketでダッシュボード（ブラウザ）へ超高速配信されます。
 * Discordチャットへの書き込みを行わないため、APIタイムアウトによるログ停止が100%発生しません。
 */

const deepl = require("deepl-node");
const { spawn } = require("child_process");
const https = require("https");
const os = require("os");
const WebSocket = require("ws");

const {
  joinVoiceChannel,
  EndBehaviorType,
  VoiceConnectionStatus,
  entersState,
} = require("@discordjs/voice");
const prism = require("prism-media");

// localtunnel 外部公開用の情報とヘルパー関数
let publicUrl = "";
let globalIp = "";

// ローカルネットワークのIPアドレスを取得
function getLocalIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

// グローバルIP（トンネルパスワード）を自動取得
function fetchGlobalIp() {
  return new Promise((resolve) => {
    https.get('https://api.ipify.org?format=json', (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const ip = JSON.parse(data).ip;
          resolve(ip);
        } catch (e) {
          resolve("取得失敗 (https://ipv4.icanhazip.com/ 等で確認してください)");
        }
      });
    }).on('error', () => {
      resolve("取得失敗");
    });
  });
}

// Cloudflare Tunnel をバックグラウンドで起動し、URLを自動パースする
async function startTunnel() {
  globalIp = await fetchGlobalIp();
  console.log(`🏠 [Local Network IP] LAN Share: http://${getLocalIp()}:3000`);

  console.log("🔌 [Tunnel] Cloudflare Tunnel (cloudflared) を起動しています...");
  // Windows環境なので npx.cmd を使用
  const tunnelProcess = spawn('npx.cmd', ['cloudflared', 'tunnel', '--url', 'http://localhost:3000'], { shell: true });
  
  tunnelProcess.stdout.on('data', (data) => {
    handleTunnelOutput(data.toString());
  });

  tunnelProcess.stderr.on('data', (data) => {
    handleTunnelOutput(data.toString());
  });

  function handleTunnelOutput(output) {
    // trycloudflare.com のURLを検索する
    const match = output.match(/(https:\/\/[a-zA-Z0-9.-]+\.trycloudflare\.com)/);
    if (match) {
      publicUrl = match[1];
      console.log(`============================================================`);
      console.log(`🌐 [Public URL Generated] (Cloudflare Tunnel - 非常に安定)`);
      console.log(`👉 ${publicUrl}`);
      console.log(`🔒 (Cloudflare Tunnelは接続時のIPパスワード入力が不要です)`);
      console.log(`============================================================`);
      
      // 開いているダッシュボードがあればURL情報を通知 (互換性のためにglobalIpも送信)
      broadcastToDashboards({
        type: "tunnel_info",
        publicUrl: publicUrl,
        globalIp: globalIp
      });
    }
  }

  tunnelProcess.on('close', (code) => {
    console.log(`🔌 [Tunnel] プロセスが終了しました (Code: ${code})。5秒後に再起動します...`);
    setTimeout(startTunnel, 5000);
  });
}

// 設定
const BUFFER_DURATION_MS = 3000; // 3秒ごとにバッファをフラッシュ
const SAMPLE_RATE = 48000;
const CHANNELS = 1; // モノラル
const BYTES_PER_SAMPLE = 2; // 16-bit = 2 bytes
const BUFFER_SIZE = SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE * (BUFFER_DURATION_MS / 1000);
const NOISE_THRESHOLD_RMS = parseInt(process.env.NOISE_THRESHOLD_RMS || "300", 10);

// 状態管理
const activeStreams = new Map(); // userId -> { buffer, timer, username }
const knownUsers = new Map(); // userId -> { username, avatarUrl }
let chatTranslationQueue = Promise.resolve(); // チャット翻訳の直列（キューイング）実行用 Promise チェーン
const voiceChannelMembers = new Map(); // userId -> { username, avatarUrl }
const userLanguages = new Map(); // userId -> 言語コード (例: "ja", "en", "id")
const userNoiseThresholds = new Map(); // userId -> しきい値 (例: 200)
const userLangHistories = new Map(); // userId -> 直近6回の検出言語配列 (例: ["ja", "ja", "en"])
let currentConnection = null;
let currentVoiceChannelId = null; // 現在BotがいるVC ID
let activeTextChannelId = null;   // 現在Botが案内を投稿した/コマンドを受け取ったテキストチャンネルID
let targetLang = "JA";
let discordClient = null;         // Discord client 参照保存用

// Gemini Live API 用の状態管理
const geminiClients = new Map(); // userId -> clientInfo
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const isGeminiMode = !!GEMINI_API_KEY;

// Gemini Live API プロンプト構築用の言語名英語マッピング
const langNamesEng = {
  "JA": "Japanese",
  "EN": "English",
  "EN-US": "English",
  "EN-GB": "English",
  "KO": "Korean",
  "ZH": "Chinese",
  "ZH-CN": "Simplified Chinese",
  "ZH-TW": "Traditional Chinese",
  "ID": "Indonesian",
  "ES": "Spanish",
  "FR": "French",
  "DE": "German",
  "RU": "Russian",
  "YUE": "Cantonese",
  "TH": "Thai",
  "VI": "Vietnamese"
};

// ハイブリッド（ローカルクライアント）接続用の状態変数
let activeWsClient = null; // ローカルPC(Transcriberクライアント)のWebSocket
let lastVramError = "";    // 直近のVRAMエラーメッセージ
const connectedDashboards = new Set(); // 接続されているブラウザダッシュボード

// クライアント側のモデル・VRAM情報
let clientFreeVram = 0.0;
let availableModels = [];
let currentModel = "";
let isClientLoading = false; // クライアントが現在モデルロード中かどうか

// DeepL 使用量キャッシュとトランスレーターインスタンス
let cachedUsage = { count: 0, limit: 1000000, percent: "0.0" };
const DEEPL_API_KEY = process.env.DEEPL_API_KEY || "";
let deeplTranslator = null;         // 環境変数によるデフォルト
let customDeeplTranslator = null;   // ユーザー指定のカスタム

// デフォルト初期化 (DeepL が無ければ自動で Gemini API を使用)
if (DEEPL_API_KEY && DEEPL_API_KEY !== "your-deepl-api-key-here") {
  try {
    deeplTranslator = new deepl.Translator(DEEPL_API_KEY);
    console.log("✅ [DeepL] デフォルトの DeepL 翻訳エンジンを初期化しました。");
    updateUsageCache(deeplTranslator);
  } catch (err) {
    console.warn("⚠️ [DeepL] 初期化に失敗しました (Gemini API 翻訳を使用します):", err.message);
  }
} else {
  console.log("☁️ [Translation Engine] Gemini API 翻訳を使用します (DeepL 未設定)。");
}

// ダッシュボード用の言語設定
let dashboardTargetLang = "JA";
let dashboardDetectLang = "auto";

/**
 * 現在BotがいるボイスチャンネルのIDを取得する
 */
function getCurrentChannelId() {
  return currentVoiceChannelId;
}

/**
 * 現在Botが紐付いているアクティブなテキストチャンネルのIDを取得する
 */
function getActiveTextChannelId() {
  return activeTextChannelId;
}

/**
 * ボイスチャンネルのメンバーを追加し、全ダッシュボードにブロードキャスト
 */
function addVoiceMember(userId, username, avatarUrl) {
  voiceChannelMembers.set(userId, { username, avatarUrl: avatarUrl || "" });
  broadcastVoiceMembers();
}

/**
 * ボイスチャンネルのメンバーを削除し、全ダッシュボードにブロードキャスト
 */
function removeVoiceMember(userId) {
  voiceChannelMembers.delete(userId);

  const stream = activeStreams.get(userId);
  if (stream) {
    if (stream.flushTimer) {
      clearTimeout(stream.flushTimer);
    }
    try {
      if (stream.opusStream) stream.opusStream.destroy();
      if (stream.decoder) stream.decoder.destroy();
    } catch (e) {
      console.warn(`⚠️ [Discord] ストリーム破棄中にエラーが発生しました (${userId}):`, e.message);
    }
    activeStreams.delete(userId);
  }

  const clientInfo = geminiClients.get(userId);
  if (clientInfo) {
    try {
      if (clientInfo.sendTimer) clearTimeout(clientInfo.sendTimer);
      clientInfo.ws.close();
    } catch (e) {}
    geminiClients.delete(userId);
  }

  broadcastVoiceMembers();
}

/**
 * ボイスチャンネルのメンバー一覧を全ダッシュボードにブロードキャスト
 */
function broadcastVoiceMembers() {
  const members = getVoiceMembersArray();
  broadcastToDashboards({
    type: "voice_members_update",
    members: members
  });
}

/**
 * ボイスチャンネルのメンバー一覧を配列として取得する
 */
function getVoiceMembersArray() {
  return Array.from(voiceChannelMembers.entries()).map(([id, info]) => {
    const strId = String(id);
    const manualLang = userLanguages.get(strId) || "auto";
    
    let activeLimit = manualLang;
    // 手動制限がなく、かつ自動履歴がある場合、自動で絞り込まれた言語をactiveLimitにセット
    if (manualLang === "auto" && userLangHistories.has(strId)) {
      const history = userLangHistories.get(strId) || [];
      if (history.length > 0) {
        const counts = {};
        history.forEach(lang => {
          counts[lang] = (counts[lang] || 0) + 1;
        });
        const sortedLangs = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
        const top2Langs = sortedLangs.slice(0, 2);
        if (top2Langs.length > 0) {
          activeLimit = "auto:" + top2Langs.join(",");
        }
      }
    }
    
    return {
      user_id: strId,
      username: info.username,
      avatar_url: info.avatarUrl,
      lang: manualLang,
      threshold: userNoiseThresholds.get(strId) ?? NOISE_THRESHOLD_RMS,
      active_limit: activeLimit
    };
  });
}

/**
 * ユーザー指定 of カスタムDeepL APIキーで翻訳エンジンを初期化・更新する
 */
function updateDeepLKey(key) {
  if (!key || key.trim() === "") {
    customDeeplTranslator = null;
    cachedUsage = { count: 0, limit: 1000000, percent: "0.0" };
    console.log("ℹ️ [DeepL] カスタムAPIキーがクリアされました。");
    broadcastToDashboards({ type: "deepl_usage_update", deeplUsage: cachedUsage });
    return;
  }
  
  try {
    customDeeplTranslator = new deepl.Translator(key.trim());
    console.log("✅ [DeepL] ユーザー指定のカスタムAPIキーで翻訳エンジンを初期化しました");
    updateUsageCache(customDeeplTranslator);
  } catch (err) {
    console.error("❌ [DeepL] カスタムAPIキーの初期化に失敗しました:", err.message);
  }
}

/**
 * DeepL の使用状況をキャッシュに更新する
 */
async function updateUsageCache(translatorInstance) {
  const translator = translatorInstance || customDeeplTranslator || deeplTranslator;
  if (!translator) return;
  
  try {
    const usage = await translator.getUsage();
    if (usage.character) {
      const count = usage.character.count;
      const limit = usage.character.limit;
      const percent = ((count / limit) * 100).toFixed(1);
      cachedUsage = { count, limit, percent };
      console.log(`📊 [DeepL Usage] ${count} / ${limit} (${percent}%)`);
      
      broadcastToDashboards({
        type: "deepl_usage_update",
        deeplUsage: cachedUsage
      });
    }
  } catch (err) {
    console.error("❌ [DeepL Usage] 取得失敗:", err.message);
  }
}

/**
 * DeepL API でテキストを翻訳する (動的キー対応)
 */
async function translateWithDeepL(text, targetLang, sourceLang) {
  const activeTranslator = customDeeplTranslator || deeplTranslator;
  
  if (!activeTranslator) {
    return { translated_text: "[翻訳スキップ: DeepL APIキーが設定されていません]", translation_skipped: true };
  }
  if (!text || !text.trim()) {
    return { translated_text: "", translation_skipped: true };
  }
  
  try {
    // 言語コード補正
    let tl = targetLang.toUpperCase();
    if (tl === "EN") tl = "EN-US";
    if (tl === "PT") tl = "PT-BR";

    const result = await activeTranslator.translateText(
      text,
      sourceLang || null,
      tl
    );
    
    updateUsageCache(activeTranslator).catch(() => {});
    
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
 * Gemini API でテキストを翻訳する (HTTP POST リクエスト、429エラー時の自動リトライ機能付き)
 */
async function translateWithGemini(text, targetLang, attempt = 1) {
  if (!GEMINI_API_KEY) {
    return { translated_text: "[翻訳スキップ: Gemini APIキーが設定されていません]", translation_skipped: true };
  }
  if (!text || !text.trim()) {
    return { translated_text: "", translation_skipped: true };
  }

  // BCP-47言語コードへのマッピング（言語名にするのが安全）
  const langNamesMap = {
    "JA": "Japanese",
    "EN-US": "English (US)",
    "EN": "English",
    "KO": "Korean",
    "ZH-HANS": "Simplified Chinese",
    "ZH-HANT": "Traditional Chinese",
    "ID": "Indonesian",
    "ES": "Spanish",
    "FR": "French",
    "DE": "German",
    "RU": "Russian"
  };
  const targetLangName = langNamesMap[targetLang.toUpperCase()] || targetLang;

  // gemini-3.1-flash-lite は非常に軽量で消費トークン(TPM)が極めて小さいため、音声通話中のAPIキー制限に干渉せず429エラーを防止できます
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${GEMINI_API_KEY}`;
  const payload = {
    contents: [
      {
        parts: [
          {
            text: `You are a professional translator. Translate the following text into ${targetLangName}. Only return the translated text without any explanations, notes, or wrapper markdown.\n\nText:\n${text}`
          }
        ]
      }
    ],
    generationConfig: {
      temperature: 0.1
    }
  };

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      let errorDetail = "";
      try {
        const errJson = JSON.parse(errorText);
        errorDetail = errJson.error?.message || errorText;
      } catch (e) {
        errorDetail = errorText;
      }

      // 429 (Too Many Requests) の場合、最大3回まで指数バックオフで自動リトライ
      if (response.status === 429 && attempt <= 3) {
        const delay = Math.round(Math.pow(1.5, attempt) * 1000); // 1.5s, 2.25s, 3.375s
        console.warn(`⚠️ [Gemini Translate] 429 レート制限（TPM/RPM等）を検知しました (${errorDetail})。${delay}ms 後にリトライします (試行 ${attempt}/3)...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        return translateWithGemini(text, targetLang, attempt + 1);
      }
      throw new Error(`HTTP error! status: ${response.status}, detail: ${errorDetail}`);
    }

    const data = await response.json();
    if (data.candidates && data.candidates[0]?.content?.parts[0]?.text) {
      const translated = data.candidates[0].content.parts[0].text.trim();
      return {
        translated_text: translated,
        translation_skipped: false
      };
    } else {
      throw new Error("Invalid response format from Gemini API");
    }
  } catch (err) {
    console.error(`❌ [Gemini Translate] 翻訳エラー (試行 ${attempt}/3): ${err.message}`);
    return { translated_text: `[翻訳エラー: ${err.message}]`, translation_skipped: true };
  }
}

/**
 * 接続されているダッシュボードの希望言語を集計し、
 * 最も多く選択されている言語を全体の dashboardTargetLang として自動適用する。
 * 全体の翻訳先が変更された場合は、Gemini Live API セッションをリセットする。
 */
function updateGlobalTargetLang() {
  if (connectedDashboards.size === 0) return;

  const counts = {};
  for (const ws of connectedDashboards) {
    const lang = ws.targetLang || "JA";
    counts[lang] = (counts[lang] || 0) + 1;
  }

  // 最頻値を取得。同数の場合は現在の dashboardTargetLang を優先
  let bestLang = dashboardTargetLang || "JA";
  let maxCount = 0;

  for (const lang of Object.keys(counts)) {
    if (counts[lang] > maxCount) {
      maxCount = counts[lang];
      bestLang = lang;
    } else if (counts[lang] === maxCount && lang === dashboardTargetLang) {
      bestLang = lang;
    }
  }

  if (bestLang !== dashboardTargetLang) {
    console.log(`🔄 [Language Router] 全体の代表翻訳先言語を ${dashboardTargetLang} から ${bestLang} に切り替えます (多数決)。`);
    dashboardTargetLang = bestLang;

    // Geminiクラウド翻訳モードのとき、全体翻訳先が変わったら
    // 既存のすべての Gemini セッションをリセットし、新しい言語で再セットアップさせる
    if (isGeminiMode) {
      console.log(`🔄 [Gemini Live API] 全体翻訳先の変更に伴い、すべてのアクティブセッションをリセットします。`);
      for (const [uid, clientInfo] of geminiClients) {
        try {
          if (clientInfo.sendTimer) clearTimeout(clientInfo.sendTimer);
          clientInfo.ws.close();
        } catch (e) {}
      }
      geminiClients.clear();
    }
  }
}

/**
 * 個別ダッシュボード接続用の DeepL 使用状況を更新する
 */
async function updateWsUsageCache(ws) {
  if (!ws.deeplTranslator) return;
  try {
    const usage = await ws.deeplTranslator.getUsage();
    if (usage.character) {
      const count = usage.character.count;
      const limit = usage.character.limit;
      const percent = ((count / limit) * 100).toFixed(1);
      ws.cachedUsage = { count, limit, percent };
      ws.send(JSON.stringify({
        type: "deepl_usage_update",
        deeplUsage: ws.cachedUsage
      }));
    }
  } catch (err) {
    console.error("❌ [DeepL Usage] 個別取得失敗:", err.message);
  }
}

/**
 * ダッシュボード（ブラウザ）のWebSocket接続をハンドリング
 */
function handleDashboardConnection(ws) {
  connectedDashboards.add(ws);
  console.log("💻 [Dashboard] ダッシュボードが接続しました");

  // 個別の設定を初期化
  ws.targetLang = "JA";
  ws.deeplTranslator = null;
  ws.cachedUsage = { count: 0, limit: 1000000, percent: "0.0" };

  // 初回接続時に現在の各種設定とクライアント情報を送る
  ws.send(JSON.stringify({
    type: "init",
    targetLang: ws.targetLang, // 個別設定
    detectLang: dashboardDetectLang,
    deeplUsage: ws.deeplTranslator ? ws.cachedUsage : cachedUsage,
    connected: currentConnection !== null,
    isModelLoading: isClientLoading, // 現在モデルロード中かどうかのフラグ
    isGeminiMode: isGeminiMode,
    voiceMembers: getVoiceMembersArray(), // VCメンバー一覧と個別言語設定
    tunnelInfo: {
      publicUrl: publicUrl,
      globalIp: globalIp
    },
    clientStatus: {
      hasClient: activeWsClient !== null,
      free_vram_gb: clientFreeVram,
      available_models: availableModels,
      current_model: currentModel
    }
  }));

  ws.on("message", (message) => {
    try {
      const data = JSON.parse(message.toString());
      
      if (data.type === "change_language" || data.type === "change_target") {
        ws.targetLang = data.lang; // この接続の翻訳先を更新
        console.log(`🌍 [Dashboard] 接続固有の翻訳先言語を変更: ${ws.targetLang}`);
        
        // 全体の代表翻訳先言語を再計算
        updateGlobalTargetLang();
      } else if (data.type === "change_detect_lang") {
        dashboardDetectLang = data.lang;
        console.log(`🎤 [Dashboard] 検出言語を変更: ${dashboardDetectLang}`);
      } else if (data.type === "change_model") {
        console.log(`🔄 [Dashboard] ASRモデルの切り替え要求: [${data.model_id}]`);
        if (activeWsClient && activeWsClient.readyState === 1) {
          activeWsClient.send(JSON.stringify({
            type: "change_model",
            model_id: data.model_id
          }));
        } else {
          console.warn("⚠️ [Dashboard] 接続中のローカルPCクライアントがないため、モデル切り替えを行えません");
        }
      } else if (data.type === "set_deepl_key") {
        console.log("🔑 [Dashboard] 接続固有のカスタムDeepL APIキーを適用します");
        if (data.key && data.key.trim() !== "") {
          try {
            ws.deeplTranslator = new deepl.Translator(data.key.trim());
            updateWsUsageCache(ws); // 使用量を初期取得
          } catch (err) {
            console.error("❌ [DeepL] 個別キーの初期化に失敗:", err.message);
          }
        } else {
          ws.deeplTranslator = null;
          ws.cachedUsage = { count: 0, limit: 1000000, percent: "0.0" };
          // 個別キー解除時は、環境変数のグローバルな使用状況を送り返す
          ws.send(JSON.stringify({
            type: "deepl_usage_update",
            deeplUsage: cachedUsage
          }));
        }
      } else if (data.type === "set_user_lang") {
        // ユーザーごとの検出言語設定を更新
        const userId = String(data.user_id);
        const lang = data.lang;
        if (lang === "auto") {
          userLanguages.delete(userId);
        } else {
          userLanguages.set(userId, lang);
        }
        console.log(`🌍 [Dashboard] ユーザー ${userId} の検出言語を変更: ${lang}`);
        
        // 既存 of 稼働中セッションがあればクローズして削除（次回発話時に新しい言語設定で再セットアップさせるため）
        const clientInfo = geminiClients.get(userId);
        if (clientInfo) {
          console.log(`🔄 [Gemini Live API] ユーザー ${userId} の検出言語変更に伴い、セッションをリセットします。`);
          try {
            if (clientInfo.sendTimer) clearTimeout(clientInfo.sendTimer);
            clientInfo.ws.close();
          } catch (e) {
            console.error(`❌ [Gemini Live API] ユーザー ${userId} のセッションクローズエラー:`, e.message);
          }
          geminiClients.delete(userId);
        }

        broadcastToDashboards({
          type: "user_lang_update",
          user_id: userId,
          lang: lang
        });
        // 手動変更時も状態更新を再配信
        broadcastVoiceMembers();
      } else if (data.type === "set_user_threshold") {
        // ユーザーごとのノイズゲートしきい値を更新
        const userId = String(data.user_id);
        const threshold = parseInt(data.threshold, 10);
        if (!isNaN(threshold)) {
          userNoiseThresholds.set(userId, threshold);
          console.log(`🎚️ [Dashboard] ユーザー ${userId} のノイズしきい値を変更: ${threshold}`);
          broadcastToDashboards({
            type: "user_threshold_update",
            user_id: userId,
            threshold: threshold
          });
          // 状態更新を再配信
          broadcastVoiceMembers();
        }
      }
    } catch (err) {
      console.error("❌ [Dashboard] メッセージ処理エラー:", err);
    }
  });

  ws.on("close", () => {
    connectedDashboards.delete(ws);
    console.log("💻 [Dashboard] ダッシュボードが切断されました");
    
    // 全体の代表翻訳先言語を再計算
    updateGlobalTargetLang();
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
        if (data.vram_status === "ok" || data.vram_status === "loading") {
          activeWsClient = ws;
          lastVramError = "";
          clientFreeVram = data.free_vram_gb || 0.0;
          availableModels = data.available_models || [];
          currentModel = data.current_model || "";
          
          console.log(`✅ [Hybrid] クライアント登録ステータス: ${data.vram_status} (空きVRAM: ${clientFreeVram.toFixed(2)} GB, 現在のモデル: ${currentModel})`);
          
          if (data.vram_status === "loading") {
            isClientLoading = true;
            // ロード中の場合、まずクライアント情報を送信してから、ロード中ステータスを送信してUIをロックする
            broadcastToDashboards({
              type: "client_status_update",
              clientStatus: {
                hasClient: true,
                free_vram_gb: clientFreeVram,
                available_models: availableModels,
                current_model: currentModel
              }
            });
            broadcastToDashboards({
              type: "model_loading",
              model_id: currentModel
            });
          } else if (data.vram_status === "ok") {
            isClientLoading = false;
            // ロード完了の場合、まずモデル変更完了を送信してUIのロックを解除し、最新ステータスを反映する
            broadcastToDashboards({
              type: "model_changed",
              current_model: currentModel
            });
            broadcastToDashboards({
              type: "client_status_update",
              clientStatus: {
                hasClient: true,
                free_vram_gb: clientFreeVram,
                available_models: availableModels,
                current_model: currentModel
              }
            });
          }
        } else {
          lastVramError = data.error_message || "不明なVRAMエラー";
          console.error(`🚨 [Hybrid] クライアント登録失敗 (起動エラー): ${lastVramError}`);
          isClientLoading = false;
          
          broadcastToDashboards({
            type: "client_error",
            error_message: lastVramError
          });
          ws.close();
        }
      } 
      
      else if (data.type === "model_loading_status") {
        const loadingModel = data.model_id || "";
        console.log(`⏳ [Hybrid] クライアントがモデルをロード中: [${loadingModel}]`);
        isClientLoading = true;
        
        broadcastToDashboards({
          type: "model_loading",
          model_id: loadingModel
        });
      }
      
      else if (data.type === "model_changed_status") {
        currentModel = data.current_model || "";
        console.log(`✨ [Hybrid] ASRモデルが正常に切り替えられました: [${currentModel}]`);
        isClientLoading = false;
        
        broadcastToDashboards({
          type: "model_changed",
          current_model: currentModel
        });
      }
      
      else if (data.type === "transcription_result") {
        const originalText = data.original_text || "";
        const detectedLang = data.detected_language || "auto";

        const normalized = originalText.toLowerCase().replace(/[.,\/#!$%\^&\*;:{}=\-_`~()?]/g, "").trim();
        const hallucinationList = ["yeah", "okay", "hmm", "uh", "um", "oh", "ah", "yep", "ding ding ding"];
        if (hallucinationList.includes(normalized) && normalized.length <= 15) {
          console.log(`🔇 [Hallucination Filtered] Ignored noise/short feedback: "${originalText}"`);
          return;
        }

        console.log(`🎤 [Hybrid] [${data.username}] ${originalText} (${detectedLang})`);

        // 有効な認識結果をユーザーの検出言語履歴に蓄積 (直近6件)
        if (detectedLang && detectedLang !== "auto") {
          const strUserId = String(data.user_id);
          if (!userLangHistories.has(strUserId)) {
            userLangHistories.set(strUserId, []);
          }
          const history = userLangHistories.get(strUserId);
          history.push(detectedLang);
          if (history.length > 6) {
            history.shift();
          }
          // 自動制限の状態（履歴）が変わったため、即時にダッシュボードへ再同期して再描画！
          broadcastVoiceMembers();
        }

        // 接続されている各ダッシュボード（ブラウザ）へ、個別に翻訳を行って送信する
        for (const wsDash of connectedDashboards) {
          if (wsDash.readyState === 1) {
            // そのダッシュボード固有の希望翻訳言語
            const currentTargetLang = wsDash.targetLang || targetLang || "JA";
            
            // 翻訳元と翻訳先が同一なら翻訳をスキップ
            const srcPrefix = detectedLang.toLowerCase().substring(0, 2);
            const tgtPrefix = currentTargetLang.toLowerCase().substring(0, 2);
            
            let translatedText = "";
            let translationSkipped = true;
            
            // 優先順位：個別キー -> グローバルカスタムキー -> 環境変数キー
            const activeTranslator = wsDash.deeplTranslator || customDeeplTranslator || deeplTranslator;
            
            if (activeTranslator && srcPrefix !== tgtPrefix) {
              try {
                let tl = currentTargetLang.toUpperCase();
                if (tl === "EN") tl = "EN-US";
                if (tl === "PT") tl = "PT-BR";

                const result = await activeTranslator.translateText(
                  originalText,
                  null,
                  tl
                );
                
                translatedText = result.text;
                translationSkipped = false;
                
                // 使用量キャッシュをバックグラウンドで更新
                if (wsDash.deeplTranslator) {
                  updateWsUsageCache(wsDash).catch(() => {});
                } else {
                  updateUsageCache(activeTranslator).catch(() => {});
                }
              } catch (err) {
                console.error(`❌ [DeepL] 個別翻訳エラー: ${err.message}`);
                translatedText = `[翻訳エラー: ${err.message}]`;
              }
            }

            // ダッシュボード固有にカスタマイズされた結果を個別に送信！
            wsDash.send(JSON.stringify({
              type: "transcription",
              user_id: data.user_id,
              username: data.username,
              avatar_url: data.avatar_url,
              original_text: originalText,
              detected_language: detectedLang,
              translated_text: translatedText,
              target_lang: currentTargetLang,
              translation_skipped: translationSkipped,
              deepl_usage: wsDash.cachedUsage || cachedUsage,
              timestamp: data.timestamp || new Date().toLocaleTimeString("ja-JP")
            }));
          }
        }
      }
    } catch (err) {
      console.error("❌ [Hybrid] メッセージ処理エラー:", err);
    }
  });

  ws.on("close", () => {
    console.log("🔌 [Hybrid] ローカルPCクライアントが切断されました。");
    if (activeWsClient === ws) {
      activeWsClient = null;
      clientFreeVram = 0.0;
      availableModels = [];
      currentModel = "";
      isClientLoading = false;
      
      broadcastToDashboards({
        type: "client_status_update",
        clientStatus: {
          hasClient: false,
          free_vram_gb: 0.0,
          available_models: [],
          current_model: ""
        }
      });
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
    if (ws.readyState === 1) {
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
async function joinChannel(channel, textChannel, _targetLang, retryCount = 0) {
  targetLang = _targetLang;
  activeTextChannelId = textChannel ? textChannel.id : null;
  if (textChannel) {
    discordClient = textChannel.client;
  }

  const { getVoiceConnection, VoiceConnectionStatus } = require("@discordjs/voice");
  let connection = getVoiceConnection(channel.guild.id);

  console.log(`⏳ ボイス接続を開始します... (試行 ${retryCount + 1}/3)`);

  if (connection) {
    if (connection.state.status !== VoiceConnectionStatus.Destroyed) {
      if (connection.joinConfig.channelId === channel.id) {
        console.log(`ℹ️ 既存の音声接続（チャンネルID: ${channel.id}）を再利用します。`);
        currentConnection = connection;
        currentVoiceChannelId = channel.id;
      } else {
        console.log(`🔄 ボイスチャンネル変更: #${channel.name} へ移動します...`);
        connection = joinVoiceChannel({
          channelId: channel.id,
          guildId: channel.guild.id,
          adapterCreator: channel.guild.voiceAdapterCreator,
          selfDeaf: false,
          selfMute: true,
        });
      }
    } else {
      console.log(`🧹 破棄済みの音声接続を検知。新規に接続を作成します...`);
      connection = joinVoiceChannel({
        channelId: channel.id,
        guildId: channel.guild.id,
        adapterCreator: channel.guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: true,
      });
    }
  } else {
    connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: true,
    });
  }

  // 重複登録を防ぐためにリスナーをクリアしてから再登録
  connection.removeAllListeners('stateChange');
  connection.removeAllListeners('error');

  connection.on('stateChange', (oldState, newState) => {
    console.log(`🔄 Voice Connection [Try ${retryCount + 1}]: ${oldState.status} -> ${newState.status}`);
  });

  connection.on('error', (error) => {
    console.error(`❌ Voice Connection Error [Try ${retryCount + 1}]:`, error);
  });

  try {
    // タイムアウトを10秒に短縮し、迅速にリトライできるようにする
    await entersState(connection, VoiceConnectionStatus.Ready, 10_000);
    console.log(`✅ ボイスチャンネルに参加成功: #${channel.name}`);
    
    currentConnection = connection;
    currentVoiceChannelId = channel.id;

    // VCメンバー一覧を構築してダッシュボードにブロードキャスト
    voiceChannelMembers.clear();
    for (const [memberId, member] of channel.members) {
      if (!member.user.bot) {
        voiceChannelMembers.set(memberId, {
          username: member.displayName,
          avatarUrl: member.displayAvatarURL({ size: 64, extension: "png" }) || ""
        });
      }
    }
    broadcastVoiceMembers();

    // 🎙️ 共有ダッシュボード案内メッセージをテキストチャンネルに自動投稿
    if (textChannel) {
      // テキストチャンネル内のBot自身の過去のすべてのメッセージをクリーンアップ
      try {
        const fetchedMessages = await textChannel.messages.fetch({ limit: 100 });
        const now = Date.now();
        const botMessages = fetchedMessages.filter(m => 
          m.author.id === textChannel.client.user.id && 
          (now - m.createdTimestamp) > 15000 // 作成から15秒以上経っているもののみ削除（現在実行中のdeferReply誤消去を防ぐため）
        );
        for (const [, m] of botMessages) {
          await m.delete().catch(() => {});
        }
        console.log(`🧹 [Discord] テキストチャンネルの過去のBotメッセージ ${botMessages.size} 件をクリーンアップしました。`);
      } catch (err) {
        console.warn("⚠️ [Discord] 過去メッセージの自動クリーンアップに失敗しました:", err.message);
      }

      let msg = `🎙️ **リアルタイム翻訳ダッシュボード**\n\n`;
      if (publicUrl) {
        msg += `📊 **共有ダッシュボードURL**\n👉 <${publicUrl}>\n\n`;
        msg += `🔑 **接続用パスワード（ホストIP）**\n👉 \`${globalIp}\` (初回アクセス時に上の画面に入力してください)\n\n`;
      } else {
        const localIp = getLocalIp();
        msg += `📊 **ローカルダッシュボードURL** (同一Wi-Fi of メンバー用)\n👉 <http://${localIp}:3000>\n\n`;
      }
      msg += `※検出言語を制限して精度を上げてください。`;

      textChannel.send(msg).catch(err => {
        console.error("❌ [Discord] ダッシュボード案内メッセージの自動投稿に失敗:", err.message);
      });
    }

    connection.receiver.speaking.on("start", (userId) => {
      const state = activeStreams.get(userId);
      if (!state || !state.isListening) {
        startListening(connection, userId);
      }
    });

    broadcastToDashboards({
      type: "voice_status",
      connected: true,
      channelName: channel.name
    });

    return connection;

  } catch (error) {
    console.error(`❌ ボイスチャンネルへの接続試行 [${retryCount + 1}/3] が失敗しました:`, error.message);
    
    // 接続を安全に破棄
    try {
      connection.destroy();
    } catch (e) {}

    if (retryCount < 2) {
      const waitTime = (retryCount + 1) * 2000; // 2秒, 4秒と待機時間を増やす（指数バックオフ）
      console.log(`⏳ ${waitTime / 1000}秒後に再試行します...`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
      return joinChannel(channel, textChannel, _targetLang, retryCount + 1);
    } else {
      console.error("🚨 すべての接続試行（3回）に失敗しました。");
      broadcastToDashboards({
        type: "voice_status",
        connected: false
      });
      throw new Error("ボイスチャンネルへの接続がタイムアウトしました。Discordのゲートウェイ接続またはネットワーク環境（UDPポート等）を確認してください。");
    }
  }
}

/**
 * ボイスチャンネルから退出
 */
async function leaveChannel(textChannel = null) {
  // 引数またはグローバル情報からクリーンアップ対象のテキストチャンネルを取得
  const targetChannel = textChannel || (discordClient && activeTextChannelId ? await discordClient.channels.fetch(activeTextChannelId).catch(() => null) : null);

  if (targetChannel) {
    try {
      const fetchedMessages = await targetChannel.messages.fetch({ limit: 100 });
      const now = Date.now();
      const clientUserId = targetChannel.client?.user?.id || (discordClient && discordClient.user?.id);
      if (clientUserId) {
        const botMessages = fetchedMessages.filter(m => 
          m.author.id === clientUserId && 
          (now - m.createdTimestamp) > 15000 // 作成から15秒以上経っているもののみ削除
        );
        for (const [, m] of botMessages) {
          await m.delete().catch(() => {});
        }
        console.log(`🧹 [Discord] leave時のメッセージクリーンアップ完了 (${botMessages.size} 件)`);
      }
    } catch (err) {
      console.warn("⚠️ [Discord] leave時のクリーンアップに失敗しました:", err.message);
    }
  }

  for (const [userId, stream] of activeStreams) {
    if (stream.flushTimer) {
      clearTimeout(stream.flushTimer);
    }
    try {
      if (stream.opusStream) stream.opusStream.destroy();
      if (stream.decoder) stream.decoder.destroy();
    } catch (e) {}
  }
  activeStreams.clear();

  if (currentConnection) {
    currentConnection.destroy();
    currentConnection = null;
    console.log("👋 ボイスチャンネルから退出しました");
  }

  // VC退出時にGeminiクライアントもすべてクリーンアップ
  for (const [userId, clientInfo] of geminiClients) {
    try {
      if (clientInfo.sendTimer) clearTimeout(clientInfo.sendTimer);
      clientInfo.ws.close();
    } catch (e) {}
  }
  geminiClients.clear();

  // VC退出時にメンバー一覧と状態をクリア
  currentVoiceChannelId = null;
  activeTextChannelId = null;
  voiceChannelMembers.clear();
  broadcastVoiceMembers();

  broadcastToDashboards({
    type: "voice_status",
    connected: false
  });
}

/**
 * 言語コードをGemini APIが解釈可能なBCP-47に変換
 */
function mapToBCP47(langCode) {
  const map = {
    "JA": "ja",
    "EN-US": "en",
    "EN": "en",
    "KO": "ko",
    "ZH-HANS": "zh-CN",
    "ZH-HANT": "zh-TW",
    "ID": "id",
    "ES": "es",
    "FR": "fr",
    "DE": "de",
    "RU": "ru"
  };
  return map[langCode.toUpperCase()] || "ja";
}

/**
 * テキストがフィラー（言い淀み・ノイズ）のみで構成されているか判定する
 */
function isFillerOnly(text) {
  if (!text) return true;
  
  // アルファベットを小文字化し、記号やスペースをすべて除去
  const clean = text.toLowerCase()
    .replace(/[.,\/\?#!$%\^&\*;:{}=\-_`~()\"\'、。！？\s]/g, "")
    .trim();
  
  if (!clean) return true;
  
  // 1. 文字起こし時にAIが出力しがちなノイズ用角括弧タグ (例: [groan], [laughter], (cough) など) の除去・判定
  if (/^\[[a-z]+\]$/.test(clean) || /^\([a-z]+\)$/.test(clean)) {
    return true;
  }
  
  // 2. 代表的なフィラー単語リスト
  const fillers = [
    "uh", "um", "ah", "oh", "er", "huh", "eh", "hm", "hmm", "ooh",
    "あ", "え", "う", "お", "ん", "あの", "えっと", "まあ", "ええ",
    "あー", "えー", "うー", "おー", "んー"
  ];
  
  // 3. 一種類の文字のみの繰り返し (例: "aaaa", "ああああ", "ううう" など) はフィラーと判定
  const firstChar = clean[0];
  const isSingleCharRepeat = clean.split("").every(c => c === firstChar);
  if (isSingleCharRepeat && (firstChar === "a" || firstChar === "u" || firstChar === "o" || firstChar === "e" || firstChar === "h" || "あえうおん".includes(firstChar))) {
    return true;
  }
  
  // 4. フィラー単語を組み合わせてできた構成かどうかチェック
  let temp = clean;
  let matched = true;
  while (temp.length > 0 && matched) {
    matched = false;
    for (const filler of fillers) {
      if (temp.startsWith(filler)) {
        temp = temp.slice(filler.length);
        matched = true;
        break;
      }
    }
  }
  
  // すべてフィラー単語で消化できた場合はフィラーのみと判定
  if (temp.length === 0) {
    return true;
  }
  
  return false;
}

/**
 * 話している最中の途中経過（プレビュー）をダッシュボードにリアルタイム配信
 */
function sendTranscriptionPreview(userId) {
  const clientInfo = geminiClients.get(userId);
  if (!clientInfo) return;

  const previewInput = clientInfo.currentInputText.trim();
  const previewOutput = clientInfo.currentOutputText.trim();

  // フィラーのみの場合は送信を制限（メーター等の無駄な点滅を防ぐため）
  if (!previewInput && !previewOutput) return;

  const username = knownUsers.get(userId)?.username || `User_${userId.slice(-4)}`;
  const avatarUrl = knownUsers.get(userId)?.avatarUrl || "";

  // 各ダッシュボードに個別送信
  for (const wsDash of connectedDashboards) {
    if (wsDash.readyState === 1) {
      const currentTargetLang = wsDash.targetLang || targetLang || "JA";
      
      // 希望言語が全体の翻訳先と同じならプレビュー翻訳を表示、異なるならプレビュー段階では翻訳を表示しない (API負荷軽減)
      const isSameAsDefault = currentTargetLang.toLowerCase().substring(0, 2) === (dashboardTargetLang || "JA").toLowerCase().substring(0, 2);
      const translatedText = isSameAsDefault ? previewOutput : "";

      wsDash.send(JSON.stringify({
        type: "transcription_preview",
        user_id: userId,
        username: username,
        avatar_url: avatarUrl,
        original_text: previewInput,
        translated_text: translatedText,
        target_lang: currentTargetLang
      }));
    }
  }
}

/**
 * 蓄積された文字起こしバッファを確定してダッシュボードに送信
 */
async function sendFinalTranscription(userId) {
  const clientInfo = geminiClients.get(userId);
  if (!clientInfo) return;

  const stream = activeStreams.get(userId);
  if (stream) {
    const now = Date.now();
    const lastSpeech = stream.lastSpeechTime || 0;
    const elapsedSinceLastSpeech = now - lastSpeech;
    
    // 最後に声（閾値以上の音量）を検知してから 2.5秒 未満の場合は、確定を保留して延期する
    if (elapsedSinceLastSpeech < 2500) {
      if (clientInfo.sendTimer) {
        clearTimeout(clientInfo.sendTimer);
      }
      const remain = 2500 - elapsedSinceLastSpeech;
      clientInfo.sendTimer = setTimeout(() => {
        sendFinalTranscription(userId);
      }, Math.max(remain, 500)); // 残り時間（最低500ms）待って再チェック
      return;
    }
  }

  const finalInput = clientInfo.currentInputText.trim();
  const finalOutput = clientInfo.currentOutputText.trim();

  // 原文と翻訳結果がともに無意味なフィラーのみの場合は、ダッシュボード送信を完全にスキップ
  if (isFillerOnly(finalInput) && isFillerOnly(finalOutput)) {
    console.log(`🔇 [Gemini Live API] フィラーのみ検出されたため送信をスキップしました: [原文] "${finalInput}" -> [翻訳] "${finalOutput}"`);
    
    // ダッシュボード側に残っているプレビュー表示をクリアするよう通知
    broadcastToDashboards({
      type: "clear_preview",
      user_id: userId
    });

    // バッファをクリアしてタイマーを解除
    clientInfo.currentInputText = "";
    clientInfo.currentOutputText = "";
    clientInfo.sendTimer = null;
    return;
  }

  if (finalInput || finalOutput) {
    console.log(`🤖 [Gemini Live API] 確定 (User: ${userId}): [原文] ${finalInput} -> [デフォルト翻訳] ${finalOutput}`);
    
    const username = knownUsers.get(userId)?.username || `User_${userId.slice(-4)}`;
    const avatarUrl = knownUsers.get(userId)?.avatarUrl || "";
    
    // ダッシュボードごとの個別翻訳キャッシュ (キー: 言語_エンジン -> { translatedText, translationSkipped })
    const translationCache = new Map();

    // 各ダッシュボードに個別翻訳して送信
    for (const wsDash of connectedDashboards) {
      if (wsDash.readyState === 1) {
        const currentTargetLang = wsDash.targetLang || targetLang || "JA";
        
        // 言語コードの比較用プレフィックス
        const srcPrefix = (userLanguages.get(userId) || "auto").toLowerCase().substring(0, 2);
        const tgtPrefix = currentTargetLang.toLowerCase().substring(0, 2);
        const defaultTgtPrefix = (dashboardTargetLang || "JA").toLowerCase().substring(0, 2);

        let translatedText = "";
        let translationSkipped = true;

        if (tgtPrefix === srcPrefix) {
          // 原文の言語と希望言語が同じなら翻訳不要
          translatedText = finalInput;
          translationSkipped = true;
        } else if (tgtPrefix === defaultTgtPrefix) {
          // 希望言語がLive APIのデフォルト翻訳先と同じなら、高品質なLive API翻訳結果をそのまま使用
          translatedText = finalOutput;
          translationSkipped = false;
        } else {
          // 希望言語が異なる場合は個別テキスト翻訳を実行 (キャッシュとキューを考慮)
          const activeTranslator = wsDash.deeplTranslator || customDeeplTranslator || deeplTranslator;
          const engineType = activeTranslator ? "deepl" : "gemini";
          const cacheKey = `${currentTargetLang.toUpperCase()}_${engineType}`;

          if (translationCache.has(cacheKey)) {
            const cached = translationCache.get(cacheKey);
            translatedText = cached.translatedText;
            translationSkipped = cached.translationSkipped;
          } else {
            if (activeTranslator) {
              try {
                let tl = currentTargetLang.toUpperCase();
                if (tl === "EN") tl = "EN-US";
                if (tl === "PT") tl = "PT-BR";

                const result = await activeTranslator.translateText(finalInput, null, tl);
                translatedText = result.text;
                translationSkipped = false;

                if (wsDash.deeplTranslator) {
                  updateWsUsageCache(wsDash).catch(() => {});
                } else {
                  updateUsageCache(activeTranslator).catch(() => {});
                }
              } catch (err) {
                console.error(`❌ [DeepL] 音声の個別翻訳エラー: ${err.message}`);
                translatedText = `[翻訳エラー: ${err.message}]`;
              }
            } else if (GEMINI_API_KEY) {
              try {
                const result = await translateWithGemini(finalInput, currentTargetLang);
                translatedText = result.translated_text;
                translationSkipped = result.translation_skipped;
              } catch (err) {
                console.error(`❌ [Gemini Translate] 音声の個別翻訳エラー: ${err.message}`);
                translatedText = `[翻訳エラー: ${err.message}]`;
              }
            }

            translationCache.set(cacheKey, { translatedText, translationSkipped });
          }
        }

        wsDash.send(JSON.stringify({
          type: "transcription",
          user_id: userId,
          username: username,
          avatar_url: avatarUrl,
          original_text: finalInput,
          detected_language: "auto",
          translated_text: translatedText,
          target_lang: currentTargetLang,
          translation_skipped: translationSkipped,
          deepl_usage: wsDash.cachedUsage || cachedUsage,
          timestamp: new Date().toLocaleTimeString("ja-JP")
        }));
      }
    }
  }

  // バッファをクリア
  clientInfo.currentInputText = "";
  clientInfo.currentOutputText = "";
  clientInfo.sendTimer = null;
}

/**
 * ユーザー専用のGemini Live API WebSocketクライアントを取得または新規作成
 */
function getOrCreateGeminiClient(userId) {
  if (!isGeminiMode) return null;
  
  let clientInfo = geminiClients.get(userId);
  let reconnectAttempts = 0;
  if (clientInfo) {
    if (clientInfo.ws.readyState === WebSocket.OPEN || clientInfo.ws.readyState === WebSocket.CONNECTING) {
      return clientInfo;
    }
    reconnectAttempts = clientInfo.reconnectAttempts;
  }

  console.log(`🔌 [Gemini Live API] ユーザー ${userId} の専用セッションを開始中...`);

  const userLang = userLanguages.get(userId) || "auto";
  const targetLangCode = dashboardTargetLang || targetLang || "JA";
  const geminiTargetLangCode = mapToBCP47(targetLangCode);

  const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`;
  const ws = new WebSocket(url);

  clientInfo = {
    ws,
    isReady: false,
    userId,
    targetLang: geminiTargetLangCode,
    reconnectAttempts: reconnectAttempts,
    currentInputText: "",
    currentOutputText: "",
    sendTimer: null
  };
  geminiClients.set(userId, clientInfo);

  ws.on("open", () => {
    console.log(`✅ [Gemini Live API] ユーザー ${userId} とのWebSocket接続が確立しました。初期セットアップを送信します...`);

    const cleanUserLang = userLang.toUpperCase();
    let inputLangName = "their native language";
    if (cleanUserLang !== "AUTO") {
      inputLangName = langNamesEng[cleanUserLang] || langNamesEng[mapToBCP47(userLang).toUpperCase()] || "their native language";
    }
    const targetLangName = langNamesEng[targetLangCode.toUpperCase()] || langNamesEng[geminiTargetLangCode.toUpperCase()] || "Japanese";

    let promptText = "";
    if (cleanUserLang === "AUTO") {
      promptText = `You are a professional real-time speech translator. Listen to the user's speech, automatically detect the language they are speaking, and translate it into ${targetLangName}. Only output the translation.`;
    } else {
      promptText = `You are a professional real-time speech translator. The user is speaking in ${inputLangName}. Please listen to their speech and translate it into ${targetLangName}. Only output the translation.`;
    }

    ws.send(JSON.stringify({
      setup: {
        model: "models/gemini-3.5-live-translate-preview",
        generationConfig: {
          responseModalities: ["AUDIO"],
          translationConfig: {
            targetLanguageCode: geminiTargetLangCode,
            echoTargetLanguage: false
          }
        },
        systemInstruction: {
          parts: [
            {
              text: promptText
            }
          ]
        },
        inputAudioTranscription: {},
        outputAudioTranscription: {}
      }
    }));
  });

  ws.on("message", (data) => {
    try {
      const message = JSON.parse(data.toString());
      
      // エラーまたは警告の検出
      if (message.error) {
        console.error(`❌ [Gemini Live API Error] (User: ${userId}):`, JSON.stringify(message.error, null, 2));
      }
      if (message.warning) {
        console.warn(`⚠️ [Gemini Live API Warning] (User: ${userId}):`, JSON.stringify(message.warning, null, 2));
      }
      
      if (message.setupComplete) {
        console.log(`✨ [Gemini Live API] ユーザー ${userId} のセットアップが完了し、通訳準備が整いました。`);
        clientInfo.isReady = true;
        clientInfo.reconnectAttempts = 0;
        
        // 接続待ちの間に溜まっていたバッファがあれば即座に送信
        const stream = activeStreams.get(userId);
        if (stream && stream.buffer.length > 0) {
          console.log(`📤 [Gemini Live API] 接続待ちバッファの送信を開始します (${stream.buffer.length} bytes)`);
          sendStreamChunk(userId);
        }
        return;
      }

      if (message.serverContent) {
        const serverContent = message.serverContent;
        
        let hasNewText = false;

        // 結合処理ヘルパー（アルファベットを含む場合はスペース区切り、日本語などの場合は直接結合）
        const mergeText = (current, add) => {
          if (!current) return add;
          const cleanAdd = add.trim();
          if (!cleanAdd) return current;
          const hasAlpha = /[a-zA-Z]/.test(current) || /[a-zA-Z]/.test(cleanAdd);
          return hasAlpha ? (current + " " + cleanAdd) : (current + cleanAdd);
        };

        // ユーザーの発言（音声認識結果）を蓄積
        if (serverContent.inputTranscription && serverContent.inputTranscription.text) {
          const cleanText = serverContent.inputTranscription.text.replace(/\{cont>/g, "");
          clientInfo.currentInputText = mergeText(clientInfo.currentInputText, cleanText);
          hasNewText = true;
        }
        
        // 翻訳結果のテキストを蓄積
        if (serverContent.outputTranscription && serverContent.outputTranscription.text) {
          const cleanText = serverContent.outputTranscription.text.replace(/\{cont>/g, "");
          clientInfo.currentOutputText = mergeText(clientInfo.currentOutputText, cleanText);
          hasNewText = true;
        }
        
        // 予備: modelTurn がある場合もマージ
        if (serverContent.modelTurn && serverContent.modelTurn.parts) {
          const textParts = serverContent.modelTurn.parts.filter(p => p.text).map(p => p.text).join("");
          if (textParts) {
            const cleanText = textParts.replace(/\{cont>/g, "");
            clientInfo.currentOutputText = mergeText(clientInfo.currentOutputText, cleanText);
            hasNewText = true;
          }
        }
        
        // 新しいテキストが届いた場合はタイマーを（再）起動
        if (hasNewText) {
          // リアルタイム・プレビューを送信
          sendTranscriptionPreview(userId);

          if (clientInfo.sendTimer) {
            clearTimeout(clientInfo.sendTimer);
          }
          clientInfo.sendTimer = setTimeout(() => {
            sendFinalTranscription(userId);
          }, 2500); // 2.5秒の沈黙で確定させる（細切れ防止）
        }

        // 💡 リアルタイム送信時の細切れ化を防ぐため、turnCompleteによる即時確定は行いません。
        // （Geminiは短い息継ぎで頻繁にturnCompleteを送るため、1.5秒の確定タイマーに処理を委ねることで一文を綺麗に繋げます）
      }
    } catch (err) {
      console.error(`❌ [Gemini Live API] メッセージパースエラー:`, err);
    }
  });

  ws.on("close", (code, reason) => {
    console.log(`🔌 [Gemini Live API] ユーザー ${userId} の接続が切断されました (Code: ${code}, Reason: ${reason})`);
    clientInfo.isReady = false;
    
    // 現在登録されているクライアント情報がこのWebSocketインスタンスと異なる場合は、
    // すでに意図的に削除または再作成されているため、再接続処理をスキップ
    const current = geminiClients.get(userId);
    if (!current || current.ws !== ws) {
      return;
    }
    
    // ユーザーがまだVCにいる場合のみ自動再接続
    const isStillInVC = voiceChannelMembers.has(userId);
    if (isStillInVC && clientInfo.reconnectAttempts < 5) {
      const delay = Math.min(1000 * Math.pow(2, clientInfo.reconnectAttempts), 10000);
      clientInfo.reconnectAttempts++;
      console.log(`⏳ [Gemini Live API] ${delay}ms 後に ユーザー ${userId} のセッションを自動再接続します... (試行 ${clientInfo.reconnectAttempts})`);
      setTimeout(() => {
        // 再接続時にまだMapに自分が登録されている場合のみ実行
        const check = geminiClients.get(userId);
        if (check && check.ws === ws) {
          getOrCreateGeminiClient(userId);
        }
      }, delay);
    } else {
      geminiClients.delete(userId);
    }
  });

  ws.on("error", (err) => {
    console.error(`❌ [Gemini Live API] エラー (User: ${userId}):`, err.message);
  });

  return clientInfo;
}

/**
 * Gemini Live API 専用: 蓄積された音声チャンクをリアルタイムで送信
 */
function sendStreamChunk(userId) {
  const stream = activeStreams.get(userId);
  if (!stream || stream.buffer.length === 0) return;

  const audioBuffer = Buffer.from(stream.buffer);
  stream.buffer = Buffer.alloc(0);

  const strUserId = String(userId);
  const clientInfo = getOrCreateGeminiClient(strUserId);

  if (clientInfo && clientInfo.isReady) {
    const rms = calculateRMS(audioBuffer);
    
    // ダッシュボードに音量(RMS)を送信
    broadcastToDashboards({
      type: "user_volume",
      user_id: strUserId,
      rms: Math.round(rms)
    });

    const userThreshold = userNoiseThresholds.get(strUserId) ?? NOISE_THRESHOLD_RMS;

    if (rms >= userThreshold) {
      // 閾値を超えた場合: 音声アクティブ状態にする (既存の無音猶予タイマーはクリア)
      stream.isVolumeActive = true;
      stream.lastSpeechTime = Date.now(); // 発話検知時刻を更新
      if (stream.volumeActiveTimer) {
        clearTimeout(stream.volumeActiveTimer);
        stream.volumeActiveTimer = null;
      }
    } else {
      // 閾値を下回った場合: すでにアクティブなら 1.5秒のハングオーバー(猶予)タイマーを起動
      if (stream.isVolumeActive && !stream.volumeActiveTimer) {
        stream.volumeActiveTimer = setTimeout(() => {
          stream.isVolumeActive = false;
          stream.volumeActiveTimer = null;
          console.log(`🔇 [Gemini Noise Gate] ゲートが閉じました (User: ${userId}, RMS: ${rms.toFixed(1)} < ${userThreshold})`);
        }, 1500); // 1.5秒の無音継続でゲートクローズ (レスポンス高速化のため短縮)
      }
    }

    // ゲートが開いている（アクティブ）場合のみ音声を Gemini に流す
    if (stream.isVolumeActive) {
      const base64Audio = audioBuffer.toString("base64");
      try {
        clientInfo.ws.send(JSON.stringify({
          realtimeInput: {
            mediaChunks: [
              {
                mimeType: "audio/pcm",
                data: base64Audio
              }
            ]
          }
        }));
      } catch (err) {
        console.error(`❌ [Gemini Live API] ストリーム送信失敗 (User: ${userId}):`, err.message);
      }
    }
  } else {
    // Geminiクライアントが接続中または未準備の場合、音声の頭切れを防ぐためバッファに保留する
    // メモリリーク防止のため最大5秒分（16000Hz * 2bytes * 5s = 160000 bytes）までに制限
    if (stream.buffer.length < 160000) {
      stream.buffer = Buffer.concat([audioBuffer, stream.buffer]);
    }
  }
}

/**
 * ユーザーの音声ストリームとデコーダーを破棄し、isListening状態をリセットする
 */
function cleanupUserStream(userId) {
  const state = activeStreams.get(userId);
  if (state) {
    if (state.silenceTimer) {
      clearTimeout(state.silenceTimer);
      state.silenceTimer = null;
    }
    // volumeActiveTimer もクリアする
    if (state.volumeActiveTimer) {
      clearTimeout(state.volumeActiveTimer);
      state.volumeActiveTimer = null;
    }
    state.isVolumeActive = false;
    try {
      if (state.opusStream) state.opusStream.destroy();
      if (state.decoder) state.decoder.destroy();
    } catch (e) {
      console.warn(`⚠️ [Discord Stream Cleanup] ストリームの破棄中に軽微な警告:`, e.message);
    }
    state.isListening = false;
  }

  // 5秒の沈黙でストリームが解放されたら、Gemini WebSocket セッションもクローズして接続枠を解放する
  const clientInfo = geminiClients.get(userId);
  if (clientInfo) {
    console.log(`🔌 [Gemini Live API] ユーザー ${userId} が無音のため、WebSocket 接続をクローズして接続枠を解放します。`);
    // closeする前に Map から消去することで、close イベント内での自動再接続を防ぐ
    geminiClients.delete(userId);
    try {
      if (clientInfo.sendTimer) {
        clearTimeout(clientInfo.sendTimer);
      }
      clientInfo.ws.close();
    } catch (e) {
      console.error(`❌ [Gemini Live API] クローズエラー:`, e.message);
    }
  }
}

/**
 * 特定ユーザーの音声リスニングを開始
 */
function startListening(connection, userId) {
  const isGemini = isGeminiMode;
  
  const endBehavior = isGemini
    ? { behavior: EndBehaviorType.Manual }
    : { behavior: EndBehaviorType.AfterSilence, duration: 500 };

  const opusStream = connection.receiver.subscribe(userId, {
    end: endBehavior,
  });

  const sampleRate = isGemini ? 16000 : SAMPLE_RATE;
  const decoder = new prism.opus.Decoder({
    rate: sampleRate,
    channels: CHANNELS,
    frameSize: 960,
  });

  if (!activeStreams.has(userId)) {
    activeStreams.set(userId, {
      buffer: Buffer.alloc(0),
      lastSendTime: 0,
      flushTimer: null,
      isListening: false,
      isVolumeActive: false,
      volumeActiveTimer: null,
      lastSpeechTime: 0, // 最後の発話（声）検知時刻
      username: knownUsers.get(userId)?.username || `User_${userId.slice(-4)}`,
      avatarUrl: knownUsers.get(userId)?.avatarUrl || "",
    });
  } else {
    // 既存の状態がある場合、ストリーム再作成に伴いタイマー類を確実にクリーンアップ
    const existingState = activeStreams.get(userId);
    if (existingState.volumeActiveTimer) {
      clearTimeout(existingState.volumeActiveTimer);
      existingState.volumeActiveTimer = null;
    }
    existingState.isVolumeActive = false;
  }

  const state = activeStreams.get(userId);
  state.isListening = true;
  state.opusStream = opusStream;
  state.decoder = decoder;

  if (state.flushTimer) {
    clearTimeout(state.flushTimer);
    state.flushTimer = null;
  }

  // 無音監視用の既存タイマーがあればクリア
  if (state.silenceTimer) {
    clearTimeout(state.silenceTimer);
    state.silenceTimer = null;
  }

  const pcmStream = opusStream.pipe(decoder);

  pcmStream.on("data", (chunk) => {
    state.buffer = Buffer.concat([state.buffer, chunk]);
    
    // Geminiモードで常時購読している場合のみ、5秒の無音監視タイマーを起動・更新
    if (isGemini) {
      if (state.silenceTimer) {
        clearTimeout(state.silenceTimer);
      }
      state.silenceTimer = setTimeout(() => {
        console.log(`🔌 [Discord Stream] 5秒間の沈黙を検知したため、ユーザー ${userId} の音声ストリームを解放します。`);
        cleanupUserStream(userId);
      }, 5000); // 5秒の沈黙でストリーム解放
      
      // 100msごとに送信 (16000 * 2 * 0.1 = 3200 bytes)
      const triggerSize = 3200;
      if (state.buffer.length >= triggerSize) {
        sendStreamChunk(userId);
      }
    }
  });

  pcmStream.on("end", () => {
    state.isListening = false;
    if (state.silenceTimer) {
      clearTimeout(state.silenceTimer);
      state.silenceTimer = null;
    }
    if (!isGemini && state.buffer.length > 0) {
      flushBuffer(userId);
    }
  });

  pcmStream.on("error", (error) => {
    state.isListening = false;
    if (state.silenceTimer) {
      clearTimeout(state.silenceTimer);
      state.silenceTimer = null;
    }
    console.error(`❌ 音声デコードエラー (${userId}):`, error.message);
  });
}

/**
 * 16-bit PCM バッファの RMS (自乗和平均平方根) を計算し、音量を求める
 */
function calculateRMS(buffer) {
  let sum = 0;
  const numSamples = buffer.length / 2;
  if (numSamples === 0) return 0;
  
  for (let i = 0; i < buffer.length; i += 2) {
    if (i + 1 < buffer.length) {
      const sample = buffer.readInt16LE(i);
      sum += sample * sample;
    }
  }
  return Math.sqrt(sum / numSamples);
}

/**
 * バッファをフラッシュしてローカルPCクライアントまたはGemini APIに送信
 */
async function flushBuffer(userId) {
  const stream = activeStreams.get(userId);
  if (!stream || stream.buffer.length === 0) return;

  if (isGeminiMode) {
    const audioBuffer = Buffer.from(stream.buffer);
    stream.buffer = Buffer.alloc(0);
    stream.lastSendTime = Date.now();
    stream.flushTimer = null;

    // 16kHz, 16bit PCM mono における最小サイズ制限 (0.8秒分 = 16000 * 2 * 0.8 = 25600 bytes)
    if (audioBuffer.length < 25600) {
      return;
    }

    const rms = calculateRMS(audioBuffer);
    const strUserId = String(userId);

    // ダッシュボードに直近の音量(RMS)を送信
    broadcastToDashboards({
      type: "user_volume",
      user_id: strUserId,
      rms: Math.round(rms)
    });

    const userThreshold = userNoiseThresholds.get(strUserId) ?? NOISE_THRESHOLD_RMS;
    if (rms < userThreshold) {
      console.log(`🔇 [Gemini Noise Gate] 音量が小さいため送信をスキップしました (RMS: ${rms.toFixed(1)} < ${userThreshold})`);
      return;
    }

    const clientInfo = getOrCreateGeminiClient(strUserId);
    if (clientInfo && clientInfo.isReady) {
      const base64Audio = audioBuffer.toString("base64");
      try {
        clientInfo.ws.send(JSON.stringify({
          realtimeInput: {
            mediaChunks: [
              {
                mimeType: "audio/pcm",
                data: base64Audio
              }
            ]
          }
        }));
      } catch (err) {
        console.error(`❌ [Gemini Live API] 送信失敗 (User: ${userId}):`, err.message);
      }
    } else {
      // 準備ができていない場合はバッファを一旦戻して待つ (メモリリーク防止のため最大5秒分 = 16000 * 2 * 5 = 160000 bytesまで)
      if (audioBuffer.length < 160000) {
        stream.buffer = Buffer.concat([audioBuffer, stream.buffer]);
      }
    }
    return;
  }

  if (!activeWsClient) {
    console.error("❌ [Hybrid] 送信エラー: 接続中のローカルPCクライアントがありません！");
    stream.buffer = Buffer.alloc(0);
    return;
  }

  const audioBuffer = Buffer.from(stream.buffer);
  stream.buffer = Buffer.alloc(0);
  stream.lastSendTime = Date.now();
  stream.flushTimer = null;

  if (audioBuffer.length < 76800) {
    return;
  }

  // 音量（RMS）によるノイズ・無音判定 (ノイズゲート)
  const rms = calculateRMS(audioBuffer);
  const strUserId = String(userId);

  // ダッシュボードに直近の音量(RMS)を送信
  broadcastToDashboards({
    type: "user_volume",
    user_id: strUserId,
    rms: Math.round(rms)
  });

  const userThreshold = userNoiseThresholds.get(strUserId) ?? NOISE_THRESHOLD_RMS;
  if (rms < userThreshold) {
    // 呼吸音や小さな環境音・マイクノイズはスキップして誤翻訳を防ぐ
    console.log(`🔇 [Noise Gate] 音量が小さいため送信をスキップしました (RMS: ${rms.toFixed(1)} < ${userThreshold})`);
    return;
  }

  const audioBase64 = audioBuffer.toString("base64");

  // 1. 手動選択された言語制限を取得
  let finalDetectLang = userLanguages.get(strUserId) || "";

  // 2. 手動選択がない(またはauto)場合はダッシュボードの全体検出設定または "auto"
  if (!finalDetectLang || finalDetectLang === "auto") {
    finalDetectLang = dashboardDetectLang || "auto";
  }

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
      detect_lang: finalDetectLang
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
    isGeminiMode: isGeminiMode,
    deeplUsage: cachedUsage,
    clientStatus: {
      free_vram_gb: clientFreeVram,
      available_models: availableModels,
      current_model: currentModel
    }
  };
}

/**
 * Discordテキストメッセージをダッシュボードごとに個別翻訳して配信する
 */
async function handleDiscordChatMessage(username, avatarUrl, text) {
  if (!text || !text.trim()) return;

  // すべてのチャット翻訳タスクを単一の実行キューで直列処理し、APIバーストを防ぐ
  chatTranslationQueue = chatTranslationQueue.then(async () => {
    try {
      // 翻訳結果の一時的なキャッシュ (キー: 言語_エンジン -> { translatedText, translationSkipped })
      const translationCache = new Map();

      for (const wsDash of connectedDashboards) {
        if (wsDash.readyState === 1) {
          // そのダッシュボード固有の希望翻訳言語
          const currentTargetLang = wsDash.targetLang || targetLang || "JA";
          
          let translatedText = "";
          let translationSkipped = true;
          
          // 優先順位：個別キー -> グローバルカスタムキー -> デフォルトキー
          const activeTranslator = wsDash.deeplTranslator || customDeeplTranslator || deeplTranslator;
          
          // キャッシュキーの定義 (言語 + 翻訳エンジンの種類)
          const engineType = activeTranslator ? "deepl" : "gemini";
          const cacheKey = `${currentTargetLang.toUpperCase()}_${engineType}`;

          if (translationCache.has(cacheKey)) {
            // すでに同一言語＆同一エンジンで翻訳済みの場合はキャッシュを利用
            const cached = translationCache.get(cacheKey);
            translatedText = cached.translatedText;
            translationSkipped = cached.translationSkipped;
          } else {
            if (activeTranslator) {
              try {
                let tl = currentTargetLang.toUpperCase();
                if (tl === "EN") tl = "EN-US";
                if (tl === "PT") tl = "PT-BR";

                const result = await activeTranslator.translateText(
                  text,
                  null,
                  tl
                );
                
                translatedText = result.text;
                translationSkipped = false;
                
                // 使用量キャッシュをバックグラウンドで更新
                if (wsDash.deeplTranslator) {
                  updateWsUsageCache(wsDash).catch(() => {});
                } else {
                  updateUsageCache(activeTranslator).catch(() => {});
                }
              } catch (err) {
                console.error(`❌ [DeepL] Discordチャットの個別翻訳エラー: ${err.message}`);
                translatedText = `[翻訳エラー: ${err.message}]`;
              }
            } else if (GEMINI_API_KEY) {
              // DeepLが未設定で、かつGeminiクラウド翻訳モードが有効ならGeminiでフォールバック！
              try {
                const result = await translateWithGemini(text, currentTargetLang);
                translatedText = result.translated_text;
                translationSkipped = result.translation_skipped;
              } catch (err) {
                console.error(`❌ [Gemini Translate] フォールバック翻訳エラー: ${err.message}`);
                translatedText = `[翻訳エラー: ${err.message}]`;
              }
            }
            
            // 結果をキャッシュに格納
            translationCache.set(cacheKey, {
              translatedText,
              translationSkipped
            });
          }

          // ダッシュボード固有に翻訳された結果を送信！
          wsDash.send(JSON.stringify({
            type: "discord_chat_message",
            username: username,
            avatar_url: avatarUrl,
            original_text: text,
            translated_text: translatedText,
            target_lang: currentTargetLang,
            translation_skipped: translationSkipped,
            timestamp: new Date().toLocaleTimeString("ja-JP")
          }));
        }
      }
      // リクエスト間のバーストを防ぐため、次の直列タスクまでに 500ms のクールダウンを入れる
      await new Promise(resolve => setTimeout(resolve, 500));
    } catch (err) {
      console.error("❌ [Chat Translation Queue] エラー:", err.message);
    }
  }).catch(err => {
    console.error("❌ [Chat Translation Queue Critical] エラー:", err.message);
  });
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
  getCurrentChannelId,
  getActiveTextChannelId,
  addVoiceMember,
  removeVoiceMember,
  startTunnel,
  translateWithDeepL,
  broadcastToDashboards,
  handleDiscordChatMessage,
};
