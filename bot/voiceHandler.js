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

// localtunnel をバックグラウンドで起動し、URLを自動パースする
async function startTunnel() {
  globalIp = await fetchGlobalIp();
  console.log(`🔑 [Tunnel Password] Host Public IP: ${globalIp}`);
  console.log(`🏠 [Local Network IP] LAN Share: http://${getLocalIp()}:3000`);

  console.log("🔌 [Tunnel] localtunnel を起動しています...");
  const tunnelProcess = spawn('npx.cmd', ['localtunnel', '--port', '3000'], { shell: true });
  
  tunnelProcess.stdout.on('data', (data) => {
    const output = data.toString();
    const match = output.match(/your url is: (https:\/\/[^\s]+)/);
    if (match) {
      publicUrl = match[1];
      console.log(`============================================================`);
      console.log(`🌐 [Public URL Generated]`);
      console.log(`👉 ${publicUrl}`);
      console.log(`🔑 [Password (IP)]`);
      console.log(`👉 ${globalIp}`);
      console.log(`============================================================`);
      
      // 開いているダッシュボードがあればURL情報を通知
      broadcastToDashboards({
        type: "tunnel_info",
        publicUrl: publicUrl,
        globalIp: globalIp
      });
    }
  });

  tunnelProcess.stderr.on('data', (data) => {
    console.error(`⚠️ [Tunnel Error] ${data.toString().trim()}`);
  });

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
const voiceChannelMembers = new Map(); // userId -> { username, avatarUrl }
const userLanguages = new Map(); // userId -> 言語コード (例: "ja", "en", "id")
const userNoiseThresholds = new Map(); // userId -> しきい値 (例: 200)
const userLangHistories = new Map(); // userId -> 直近6回の検出言語配列 (例: ["ja", "ja", "en"])
let currentConnection = null;
let currentVoiceChannelId = null; // 現在BotがいるVC ID
let activeTextChannelId = null;   // 現在Botが案内を投稿した/コマンドを受け取ったテキストチャンネルID
let targetLang = "JA";

// Gemini Live API 用の状態管理
const geminiClients = new Map(); // userId -> clientInfo
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const isGeminiMode = !!GEMINI_API_KEY;

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

// デフォルト初期化
if (DEEPL_API_KEY && DEEPL_API_KEY !== "your-deepl-api-key-here") {
  try {
    deeplTranslator = new deepl.Translator(DEEPL_API_KEY);
    console.log("✅ [DeepL] デフォルトの DeepL 翻訳エンジンを初期化しました");
    updateUsageCache(deeplTranslator);
  } catch (err) {
    console.error("❌ [DeepL] デフォルトエンジンの初期化に失敗:", err.message);
  }
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

  // VC退出時にGeminiクライアントもすべてクリーンアップ
  for (const [userId, clientInfo] of geminiClients) {
    try {
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
 * 蓄積された文字起こしバッファを確定してダッシュボードに送信
 */
function sendFinalTranscription(userId) {
  const clientInfo = geminiClients.get(userId);
  if (!clientInfo) return;

  const finalInput = clientInfo.currentInputText.trim();
  const finalOutput = clientInfo.currentOutputText.trim();

  if (finalInput || finalOutput) {
    console.log(`🤖 [Gemini Live API] 確定送信 (User: ${userId}): [原文] ${finalInput} -> [翻訳] ${finalOutput}`);
    
    const userLang = userLanguages.get(userId) || dashboardTargetLang || targetLang || "JA";
    const username = knownUsers.get(userId)?.username || `User_${userId.slice(-4)}`;
    const avatarUrl = knownUsers.get(userId)?.avatarUrl || "";
    
    // 各ダッシュボードに送信
    for (const wsDash of connectedDashboards) {
      if (wsDash.readyState === 1) {
        wsDash.send(JSON.stringify({
          type: "transcription",
          user_id: userId,
          username: username,
          avatar_url: avatarUrl,
          original_text: finalInput,
          detected_language: "auto",
          translated_text: finalOutput,
          target_lang: userLang,
          translation_skipped: false,
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

  const userLang = userLanguages.get(userId) || dashboardTargetLang || targetLang || "JA";
  const geminiLangCode = mapToBCP47(userLang);

  const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`;
  const ws = new WebSocket(url);

  clientInfo = {
    ws,
    isReady: false,
    userId,
    targetLang: geminiLangCode,
    reconnectAttempts: reconnectAttempts,
    currentInputText: "",
    currentOutputText: "",
    sendTimer: null
  };
  geminiClients.set(userId, clientInfo);

  ws.on("open", () => {
    console.log(`✅ [Gemini Live API] ユーザー ${userId} とのWebSocket接続が確立しました。初期セットアップを送信します...`);
    ws.send(JSON.stringify({
      setup: {
        model: "models/gemini-3.5-live-translate-preview",
        generationConfig: {
          responseModalities: ["AUDIO"],
          translationConfig: {
            targetLanguageCode: geminiLangCode,
            echoTargetLanguage: false
          }
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
        return;
      }

      if (message.serverContent) {
        const serverContent = message.serverContent;
        
        // 音声データ(Base64)が長いため、デバッグログ出力時に省略表示にします
        let debugContent = JSON.parse(JSON.stringify(serverContent));
        if (debugContent.modelTurn && debugContent.modelTurn.parts) {
          for (let p of debugContent.modelTurn.parts) {
            if (p.inlineData && p.inlineData.data) {
              p.inlineData.data = `[Base64 Audio: ${p.inlineData.data.length} bytes]`;
            }
          }
        }
        console.log(`📨 [Gemini Debug Message] (User: ${userId}):`, JSON.stringify(debugContent, null, 2));
        
        let hasNewText = false;

        // ユーザーの発言（音声認識結果）を蓄積
        if (serverContent.inputTranscription && serverContent.inputTranscription.text) {
          clientInfo.currentInputText += " " + serverContent.inputTranscription.text;
          hasNewText = true;
        }
        
        // 翻訳結果のテキストを蓄積
        if (serverContent.outputTranscription && serverContent.outputTranscription.text) {
          clientInfo.currentOutputText += " " + serverContent.outputTranscription.text;
          hasNewText = true;
        }
        
        // 予備: modelTurn がある場合もマージ
        if (serverContent.modelTurn && serverContent.modelTurn.parts) {
          const textParts = serverContent.modelTurn.parts.filter(p => p.text).map(p => p.text).join("");
          if (textParts) {
            clientInfo.currentOutputText += " " + textParts;
            hasNewText = true;
          }
        }
        
        // 新しいテキストが届いた場合はタイマーを（再）起動
        if (hasNewText) {
          if (clientInfo.sendTimer) {
            clearTimeout(clientInfo.sendTimer);
          }
          clientInfo.sendTimer = setTimeout(() => {
            sendFinalTranscription(userId);
          }, 1200);
        }
        
        // ターンが完了（話し終わった）したら即座に送信
        if (serverContent.turnComplete) {
          if (clientInfo.sendTimer) {
            clearTimeout(clientInfo.sendTimer);
          }
          sendFinalTranscription(userId);
        }
      }
    } catch (err) {
      console.error(`❌ [Gemini Live API] メッセージパースエラー:`, err);
    }
  });

  ws.on("close", (code, reason) => {
    console.log(`🔌 [Gemini Live API] ユーザー ${userId} の接続が切断されました (Code: ${code}, Reason: ${reason})`);
    clientInfo.isReady = false;
    
    // ユーザーがまだVCにいる場合のみ自動再接続
    const isStillInVC = voiceChannelMembers.has(userId);
    if (isStillInVC && clientInfo.reconnectAttempts < 5) {
      const delay = Math.min(1000 * Math.pow(2, clientInfo.reconnectAttempts), 10000);
      clientInfo.reconnectAttempts++;
      console.log(`⏳ [Gemini Live API] ${delay}ms 後に ユーザー ${userId} のセッションを自動再接続します... (試行 ${clientInfo.reconnectAttempts})`);
      setTimeout(() => {
        getOrCreateGeminiClient(userId);
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
 * 特定ユーザーの音声リスニングを開始
 */
function startListening(connection, userId) {
  const opusStream = connection.receiver.subscribe(userId, {
    end: {
      behavior: EndBehaviorType.AfterSilence,
      duration: 500,
    },
  });

  const sampleRate = isGeminiMode ? 16000 : SAMPLE_RATE;
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

  for (const wsDash of connectedDashboards) {
    if (wsDash.readyState === 1) {
      // そのダッシュボード固有の希望翻訳言語
      const currentTargetLang = wsDash.targetLang || targetLang || "JA";
      
      let translatedText = "";
      let translationSkipped = true;
      
      // 優先順位：個別キー -> グローバルカスタムキー -> デフォルトキー
      const activeTranslator = wsDash.deeplTranslator || customDeeplTranslator || deeplTranslator;
      
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
