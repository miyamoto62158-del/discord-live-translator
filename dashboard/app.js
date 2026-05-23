/**
 * app.js - ダッシュボードのクライアントサイドスクリプト
 *
 * WebSocketでBotサーバーに接続し、
 * リアルタイムの文字起こし・翻訳結果を表示、各種コントロールを行います。
 * すべてのドロップダウンはブラウザの自動翻訳機能（Google翻訳等）に対応しています。
 */

// ── 設定 ──
const WS_URL = (window.location.protocol === 'https:' ? 'wss://' : 'ws://') + window.location.host + '/ws';
const RECONNECT_INTERVAL = 3000;
const MAX_MESSAGES = 200;

// ── 状態 ──
let ws = null;
let messageCount = 0;
let isConnected = false;
let autoScroll = true;  // 自動追従フラグ
let cachedClientStatus = null; // キャッシュされたクライアント情報
let isModelLoading = false;    // ASRモデルロード中フラグ

const userColors = {};
const colorPalette = [
    '#5865F2', '#57F287', '#FEE75C', '#EB459E', '#ED4245', '#3BA55D',
    '#FAA81A', '#9B59B6', '#1ABC9C', '#E91E63', '#00BCD4', '#FF5722',
];
let colorIndex = 0;

const langFlags = {
    'en': '🇺🇸', 'ja': '🇯🇵', 'ko': '🇰🇷', 'zh': '🇨🇳',
    'es': '🇪🇸', 'fr': '🇫🇷', 'de': '🇩🇪', 'pt': '🇧🇷',
    'ru': '🇷🇺', 'id': '🇮🇩', 'th': '🇹🇭', 'vi': '🇻🇳',
    'ar': '🇸🇦', 'it': '🇮🇹', 'nl': '🇳🇱', 'pl': '🇵🇱',
    'tr': '🇹🇷', 'hi': '🇮🇳', 'sv': '🇸🇪', 'da': '🇩🇰',
};

const langNames = {
    'en': 'English', 'ja': '日本語', 'ko': '한국어', 'zh': '中文',
    'es': 'Español', 'fr': 'Français', 'de': 'Deutsch', 'pt': 'Português',
    'ru': 'Русский', 'id': 'Indonesia', 'th': 'ไทย', 'vi': 'Tiếng Việt',
    'ar': 'العربية', 'it': 'Italiano', 'nl': 'Nederlands', 'pl': 'Polski',
    'tr': 'Türkçe', 'hi': 'हिन्दी',
};

const targetLangFlags = {
    'JA': '🇯🇵', 'EN-US': '🇺🇸', 'EN-GB': '🇬🇧', 'KO': '🇰🇷',
    'ZH-HANS': '🇨🇳', 'ZH-HANT': '🇹🇼', 'ES': '🇪🇸', 'FR': '🇫🇷',
    'DE': '🇩🇪', 'ID': '🇮🇩', 'PT-BR': '🇧🇷', 'RU': '🇷🇺',
    'IT': '🇮🇹', 'NL': '🇳🇱', 'PL': '🇵🇱', 'TR': '🇹🇷',
};
const targetLangNames = {
    'JA': '日本語', 'EN-US': 'English', 'EN-GB': 'English', 'KO': '한국어',
    'ZH-HANS': '中文', 'ZH-HANT': '中文', 'ES': 'Español', 'FR': 'Français',
    'DE': 'Deutsch', 'ID': 'Indonesia', 'PT-BR': 'Português', 'RU': 'Русский',
    'IT': 'Italiano', 'NL': 'Nederlands', 'PL': 'Polski', 'TR': 'Türkçe',
};

// ── DOM要素 ──
const elements = {
    container: document.getElementById('transcript-container'),
    welcome: document.getElementById('welcome-message'),
    status: document.getElementById('connection-status'),
    statusText: document.querySelector('.status-text'),
    messageCount: document.getElementById('message-count'),
    lastUpdate: document.getElementById('last-update'),
    deeplUsage: document.getElementById('deepl-usage'),
    clearBtn: document.getElementById('clear-btn'),
    autoScrollBtn: document.getElementById('auto-scroll-btn'),
    
    // カスタムセレクトボックス要素 (ブラウザ自動翻訳対応)
    modelSelectWrapper: document.getElementById('model-select-wrapper'),
    modelSelectText: document.getElementById('model-select-text'),
    modelOptions: document.getElementById('model-options'),
    vramInfo: document.getElementById('vram-info'),
    
    detectLangWrapper: document.getElementById('detect-lang-wrapper'),
    detectLangText: document.getElementById('detect-lang-text'),
    detectLangOptions: document.getElementById('detect-lang-options'),
    
    targetLangWrapper: document.getElementById('target-lang-wrapper'),
    targetLangText: document.getElementById('target-lang-text'),
    targetLangOptions: document.getElementById('target-lang-options'),
    
    // DeepL設定
    deeplKeyInput: document.getElementById('deepl-key-input'),
    applyKeyBtn: document.getElementById('apply-key-btn')
};

// ── WebSocket接続 ──
function connect() {
    if (ws && ws.readyState === WebSocket.OPEN) return;
    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
        isConnected = true;
        updateConnectionStatus(true);
        
        // 初期カスタムセレクトの選択状態を送信
        const activeTarget = elements.targetLangOptions.querySelector('.custom-option.selected')?.getAttribute('data-value') || 'JA';
        const activeDetect = elements.detectLangOptions.querySelector('.custom-option.selected')?.getAttribute('data-value') || 'auto';
        
        ws.send(JSON.stringify({ type: 'change_language', lang: activeTarget }));
        ws.send(JSON.stringify({ type: 'change_detect_lang', lang: activeDetect }));
        
        // 保存されているDeepL APIキーがあれば自動適用
        const savedKey = localStorage.getItem('deepl_api_key');
        if (savedKey) {
            ws.send(JSON.stringify({ type: 'set_deepl_key', key: savedKey }));
            if (elements.deeplKeyInput) {
                elements.deeplKeyInput.value = savedKey;
            }
        }
    };

    ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        handleMessage(data);
    };

    ws.onclose = () => {
        isConnected = false;
        isModelLoading = false;
        updateConnectionStatus(false);
        updateClientStatus(null); // クライアント状態を未接続にする
        updateVoiceStatus(false); // 音声接続状態も解除
        setTimeout(connect, RECONNECT_INTERVAL);
    };

    ws.onerror = () => {};
}

// ── メッセージ処理 ──
function handleMessage(data) {
    switch (data.type) {
        case 'init':
            if (data.deeplUsage) {
                updateDeepLUsage(data.deeplUsage);
            }
            if (data.clientStatus) {
                updateClientStatus(data.clientStatus);
            }
            updateVoiceStatus(data.connected);
            break;
            
        case 'client_status_update':
            updateClientStatus(data.clientStatus);
            break;
            
        case 'model_loading':
            // 1. モデルロード中のフラグをセット
            isModelLoading = true;
            if (elements.modelSelectWrapper) {
                elements.modelSelectWrapper.classList.add('disabled');
            }
            
            // 2. 表示を「⏳ ロード中」に変更してフリーズ
            const modelNames = {
                "qwen3": "Qwen3-ASR-1.7B",
                "whisper_large": "Whisper Large-v3",
                "whisper_medium": "Whisper Medium",
                "whisper_small": "Whisper Small"
            };
            const mName = modelNames[data.model_id] || data.model_id;
            if (elements.modelSelectText) {
                elements.modelSelectText.textContent = `⏳ ${mName} をロード中...`;
            }
            console.log(`⏳ ASRモデルロード中表示に切り替えました: [${mName}]`);
            break;
            
        case 'model_changed':
            // 1. ロードが完了したため、ガードを解除
            isModelLoading = false;
            if (elements.modelSelectWrapper) {
                elements.modelSelectWrapper.classList.remove('disabled');
            }
            
            // 2. クライアントキャッシュの現在のアクティブモデルIDを更新して画面再構築
            if (cachedClientStatus) {
                cachedClientStatus.current_model = data.current_model;
                updateClientStatus(cachedClientStatus);
            }
            console.log(`✨ ASRモデルロード完了表示に切り替えました: [${data.current_model}]`);
            break;
            
        case 'voice_status':
            updateVoiceStatus(data.connected, data.channelName);
            break;
            
        case 'deepl_usage_update':
            if (data.deeplUsage) {
                updateDeepLUsage(data.deeplUsage);
            }
            break;
            
        case 'client_error':
            alert(`⚠️ 音声認識クライアントエラー:\n${data.error_message}`);
            break;
            
        case 'transcription':
            addTranscriptionCard(data);
            if (data.deepl_usage) {
                updateDeepLUsage(data.deepl_usage);
            }
            break;
    }
}

// ── 音声認識クライアント（GPU/モデル）状態の表示更新 ──
function updateClientStatus(status) {
    // モデルロード中の場合は、他のステータスパケットによる画面書き換え（上書き）を完全にシャットアウト
    if (isModelLoading) {
        console.log("⏳ ロード中ロック中のため、ステータス自動更新をスキップします");
        return;
    }

    cachedClientStatus = status;
    if (!elements.modelSelectWrapper || !elements.vramInfo || !elements.modelOptions) return;
    
    if (!status || !status.hasClient) {
        // 文字起こしクライアントが接続されていない場合
        elements.modelSelectText.textContent = '未接続 (待ち...)';
        elements.modelSelectWrapper.classList.add('disabled');
        elements.vramInfo.textContent = '(--GB)';
        elements.modelOptions.innerHTML = '';
        return;
    }
    
    // VRAM空き容量の表示更新
    elements.vramInfo.textContent = `(${status.free_vram_gb.toFixed(1)}GB)`;
    elements.modelSelectWrapper.classList.remove('disabled');
    
    // 利用可能なモデルドロップダウンの動的再構築
    elements.modelOptions.innerHTML = '';
    let activeModelName = '接続待ち...';
    
    status.available_models.forEach(model => {
        const isCurrent = model.id === status.current_model;
        const opt = document.createElement('div');
        opt.className = `custom-option${isCurrent ? ' selected' : ''}`;
        opt.setAttribute('data-value', model.id);
        opt.textContent = model.name;
        
        if (isCurrent) {
            activeModelName = model.name;
        }
        
        // クリックイベントの登録
        opt.addEventListener('click', () => {
            onModelChange(model.id);
        });
        
        elements.modelOptions.appendChild(opt);
    });
    
    elements.modelSelectText.textContent = activeModelName;
}

// ── ASRモデル変更 ──
function onModelChange(modelId) {
    if (!modelId) return;
    
    // モデル切り替え処理が走るため、ロード中状態を先行適用
    isModelLoading = true;
    if (elements.modelSelectWrapper) {
        elements.modelSelectWrapper.classList.add('disabled');
    }
    
    const modelNames = {
        "qwen3": "Qwen3-ASR-1.7B",
        "whisper_large": "Whisper Large-v3",
        "whisper_medium": "Whisper Medium",
        "whisper_small": "Whisper Small"
    };
    const mName = modelNames[modelId] || modelId;
    if (elements.modelSelectText) {
        elements.modelSelectText.textContent = `⏳ ${mName} をロード中...`;
    }
    
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'change_model', model_id: modelId }));
        console.log(`🔄 モデル切り替えを要求: ${modelId}`);
    }
}

// ── BotのVoice接続状態の表示更新 ──
function updateVoiceStatus(connected, channelName) {
    isInVoice = connected;
    updateVoiceButtons();
    
    if (elements.welcome) {
        if (connected) {
            elements.welcome.style.display = 'none';
        } else {
            // 発言履歴が空のときのみウェルカム画面を表示する
            const cards = elements.container.querySelectorAll('.transcript-card');
            if (cards.length === 0) {
                elements.welcome.style.display = 'flex';
            }
        }
    }
    
    if (connected && channelName) {
        console.log(`🎙️ Botがボイスチャンネルに参加しました: #${channelName}`);
    }
}

// ── DeepL APIキー適用 ──
function applyDeepLKey() {
    if (!elements.deeplKeyInput) return;
    const key = elements.deeplKeyInput.value.trim();
    
    // ローカルブラウザに保存
    localStorage.setItem('deepl_api_key', key);
    
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'set_deepl_key', key: key }));
        console.log("🔑 カスタムDeepL APIキーを適用しました");
    }
    
    alert('DeepL APIキーを保存し、適用しました！');
}

// ── 発言カードを追加 ──
function addTranscriptionCard(data) {
    if (elements.welcome) elements.welcome.style.display = 'none';

    if (!userColors[data.user_id]) {
        userColors[data.user_id] = colorPalette[colorIndex % colorPalette.length];
        colorIndex++;
    }
    const userColor = userColors[data.user_id];
    const flag = langFlags[data.detected_language] || '🌍';
    const langName = langNames[data.detected_language] || data.detected_language;

    const card = document.createElement('div');
    card.className = 'transcript-card';

    const initial = data.username.charAt(0).toUpperCase();
    const avatarHtml = data.avatar_url
        ? `<img class="card-avatar-img" src="${escapeHtml(data.avatar_url)}" alt="${escapeHtml(data.username)}" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
           <div class="card-avatar card-avatar-fallback" style="background: ${userColor}; display: none">${initial}</div>`
        : `<div class="card-avatar" style="background: ${userColor}">${initial}</div>`;

    card.innerHTML = `
        <div class="card-avatar-wrapper">${avatarHtml}</div>
        <div class="card-content">
            <div class="card-header">
                <span class="card-username" style="color: ${userColor}">${escapeHtml(data.username)}</span>
                <span class="card-timestamp">${data.timestamp}</span>
            </div>
            <div class="card-original">
                <span class="card-lang-badge">${flag} ${langName}</span>
                <span class="original-text">${escapeHtml(data.original_text)}</span>
            </div>
            ${getTranslationHtml(data)}
        </div>
    `;

    const firstCard = elements.container.querySelector('.transcript-card');
    if (firstCard) {
        elements.container.insertBefore(card, firstCard);
    } else {
        elements.container.appendChild(card);
    }

    messageCount++;
    elements.messageCount.textContent = `${messageCount} 件の発言`;
    elements.lastUpdate.textContent = `最終更新: ${data.timestamp}`;

    const cards = elements.container.querySelectorAll('.transcript-card');
    if (cards.length > MAX_MESSAGES) cards[cards.length - 1].remove();

    if (autoScroll) scrollToTop();
}

// ── 翻訳テキストのHTML生成 ──
function getTranslationHtml(data) {
    if (data.translation_skipped) {
        return `<div class="card-translation skipped">
            <span class="arrow">→</span>
            <span>(翻訳不要またはAPIキー未設定)</span>
        </div>`;
    }
    if (data.translated_text) {
        const srcFlag = langFlags[data.detected_language] || '🌍';
        const srcName = langNames[data.detected_language] || data.detected_language;
        const tgtFlag = targetLangFlags[data.target_lang] || '🌐';
        const tgtName = targetLangNames[data.target_lang] || data.target_lang;
        return `<div class="card-translation">
            <div class="translation-lang-row">
                <span class="translation-from">${srcFlag} ${srcName}</span>
                <span class="arrow">→</span>
                <span class="translation-to">${tgtFlag} ${tgtName}</span>
            </div>
            <div class="translation-text">${escapeHtml(data.translated_text)}</div>
        </div>`;
    }
    return '';
}

// ── DeepL使用状況の表示更新 ──
function updateDeepLUsage(usage) {
    if (elements.deeplUsage && usage && usage.limit > 0) {
        elements.deeplUsage.textContent = `DeepL使用量: ${usage.count.toLocaleString()} / ${usage.limit.toLocaleString()} (${usage.percent}%)`;
    }
}

// ── ユーティリティ ──
function updateConnectionStatus(connected) {
    elements.status.className = `status-badge ${connected ? 'connected' : 'disconnected'}`;
    elements.statusText.textContent = connected ? '接続中' : '切断中';
}

function scrollToTop() {
    requestAnimationFrame(() => { elements.container.scrollTop = 0; });
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ── 履歴クリア ──
function clearTranscripts() {
    elements.container.querySelectorAll('.transcript-card').forEach((c) => c.remove());
    messageCount = 0;
    elements.messageCount.textContent = '0 件の発言';
    elements.lastUpdate.textContent = '最終更新: --:--:--';
    if (!isInVoice && elements.welcome) elements.welcome.style.display = 'flex';
}

// ── ボイスチャンネル操作 ──
let isInVoice = false;

async function leaveVoice() {
    try {
        await fetch('/api/leave', { method: 'POST' });
        isInVoice = false;
        updateVoiceButtons();
    } catch (e) {}
}

function updateVoiceButtons() {
    const leaveBtn = document.getElementById('leave-btn');
    if (leaveBtn) leaveBtn.style.display = isInVoice ? 'inline-flex' : 'none';
}


// ── 自動追従トグル ──
function toggleAutoScroll() {
    autoScroll = !autoScroll;
    const btn = elements.autoScrollBtn;
    if (autoScroll) {
        btn.textContent = '📌 自動追従: ON';
        btn.classList.add('active');
        scrollToTop();
    } else {
        btn.textContent = '📌 自動追従: OFF';
        btn.classList.remove('active');
    }
}

// ── カスタムセレクトボックスのインタラクション初期化 ──
function setupCustomSelects() {
    // トリガーをクリックした時の開閉制御
    document.querySelectorAll('.custom-select-trigger').forEach(trigger => {
        trigger.addEventListener('click', (e) => {
            e.stopPropagation();
            const parent = trigger.parentElement;
            
            // 他のドロップダウンをすべて閉じる
            document.querySelectorAll('.custom-select').forEach(el => {
                if (el !== parent) el.classList.remove('open');
            });
            
            // 自身を切り替え
            parent.classList.toggle('open');
        });
    });

    // 画面上の他の場所をクリックしたときにドロップダウンを閉じる
    document.addEventListener('click', () => {
        document.querySelectorAll('.custom-select').forEach(el => el.classList.remove('open'));
    });
}

// 音声言語カスタムセレクトボックスのセットアップ
function setupDetectLangSelect() {
    if (!elements.detectLangOptions) return;
    
    elements.detectLangOptions.querySelectorAll('.custom-option').forEach(option => {
        option.addEventListener('click', () => {
            const val = option.getAttribute('data-value');
            
            elements.detectLangOptions.querySelectorAll('.custom-option').forEach(o => o.classList.remove('selected'));
            option.classList.add('selected');
            
            if (elements.detectLangText) {
                elements.detectLangText.textContent = option.textContent;
            }
            
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'change_detect_lang', lang: val }));
            }
        });
    });
}

// 翻訳先言語カスタムセレクトボックスのセットアップ
function setupTargetLangSelect() {
    if (!elements.targetLangOptions) return;
    
    elements.targetLangOptions.querySelectorAll('.custom-option').forEach(option => {
        option.addEventListener('click', () => {
            const val = option.getAttribute('data-value');
            
            elements.targetLangOptions.querySelectorAll('.custom-option').forEach(o => o.classList.remove('selected'));
            option.classList.add('selected');
            
            if (elements.targetLangText) {
                elements.targetLangText.textContent = option.textContent;
            }
            
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'change_language', lang: val }));
            }
        });
    });
}


// ── イベントリスナー ──
elements.clearBtn.addEventListener('click', clearTranscripts);
elements.autoScrollBtn.addEventListener('click', toggleAutoScroll);
document.getElementById('leave-btn')?.addEventListener('click', leaveVoice);

// DeepL APIキー適用
elements.applyKeyBtn?.addEventListener('click', applyDeepLKey);

// カスタムセレクトコントロールの初期化
setupCustomSelects();
setupDetectLangSelect();
setupTargetLangSelect();

// ── 起動 ──
connect();
