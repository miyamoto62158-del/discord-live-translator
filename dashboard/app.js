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
let voiceMembers = []; // 現在VCにいるメンバーの配列
let isModelLoading = false;    // ASRモデルロード中フラグ
let isGeminiMode = false;      // Geminiクラウド翻訳モード有効フラグ

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
    
    voiceMembersPanel: document.getElementById('voice-members-panel'),
    voiceMembersList: document.getElementById('voice-members-list'),
    
    targetLangWrapper: document.getElementById('target-lang-wrapper'),
    targetLangText: document.getElementById('target-lang-text'),
    targetLangOptions: document.getElementById('target-lang-options'),
    
    // DeepL設定
    deeplKeyInput: document.getElementById('deepl-key-input'),
    applyKeyBtn: document.getElementById('apply-key-btn'),
    connectionWarning: document.getElementById('connection-warning'),
    discordChatList: document.getElementById('discord-chat-list')
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
        
        ws.send(JSON.stringify({ type: 'change_language', lang: activeTarget }));
        
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
            toggleGeminiMode(data.isGeminiMode);
            if (data.deeplUsage) {
                updateDeepLUsage(data.deeplUsage);
            }
            if (data.isModelLoading) {
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
                const currentModelId = data.clientStatus ? data.clientStatus.current_model : '';
                const mName = modelNames[currentModelId] || currentModelId || "モデル";
                if (elements.modelSelectText) {
                    elements.modelSelectText.textContent = `⏳ ${mName} をロード中...`;
                }
            }
            if (data.clientStatus) {
                updateClientStatus(data.clientStatus);
            }
            if (data.voiceMembers && data.voiceMembers.length > 0) {
                voiceMembers = data.voiceMembers;
                renderVoiceMembers();
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
            
        case 'discord_chat_message':
            addDiscordChatCard(data);
            break;
            
        case 'voice_members_update':
            voiceMembers = data.members || [];
            renderVoiceMembers();
            break;

        case 'user_lang_update':
            // 他のダッシュボードからの言語変更を反映
            const member = voiceMembers.find(m => m.user_id === data.user_id);
            if (member) {
                const oldLang = member.lang;
                member.lang = data.lang;
                renderVoiceMembers();
                
                if (oldLang !== data.lang) {
                    const langLabel = data.lang === 'auto' ? '🌐 Auto Detect' : (langNames[data.lang] || data.lang);
                    showToast(`${member.username} の検出言語が「${langLabel}」に更新されました`, 'info');
                }
            }
            break;

        case 'user_threshold_update':
            const m = voiceMembers.find(member => member.user_id === data.user_id);
            if (m) {
                const oldThreshold = m.threshold;
                m.threshold = data.threshold;
                
                // UIのスライダーと数値表示を更新
                const card = document.querySelector(`.voice-member-card[data-user-id="${data.user_id}"]`);
                if (card) {
                    const slider = card.querySelector('.threshold-slider');
                    const valueDisplay = card.querySelector('.threshold-value');
                    if (slider) slider.value = data.threshold;
                    if (valueDisplay) valueDisplay.textContent = data.threshold;
                }
                
                if (oldThreshold !== data.threshold) {
                    showToast(`${m.username} のノイズしきい値が「${data.threshold}」に更新されました`, 'info');
                }
            }
            break;
    }
}

// ── Geminiクラウドモードのトグル ──
function toggleGeminiMode(isGemini) {
    isGeminiMode = !!isGemini;
    const geminiWarning = document.getElementById('gemini-warning');
    if (isGeminiMode) {
        if (geminiWarning) {
            geminiWarning.classList.add('show');
        }
        if (elements.modelSelectWrapper) {
            elements.modelSelectWrapper.classList.add('disabled');
        }
        if (elements.modelSelectText) {
            elements.modelSelectText.textContent = '☁️ Gemini 3.5 Live';
        }
        if (elements.vramInfo) {
            elements.vramInfo.style.display = 'none';
        }
        const welcome = elements.welcome;
        if (welcome) {
            const welcomeNote = welcome.querySelector('.welcome-note');
            if (welcomeNote && !welcomeNote.dataset.geminiModified) {
                welcomeNote.innerHTML += `<br><span style="color: var(--accent-green); font-weight: bold;">⚡ 現在クラウド翻訳(Gemini)が有効なため、GPUクライアントの起動は不要です！</span>`;
                welcomeNote.dataset.geminiModified = "true";
            }
        }
    } else {
        if (geminiWarning) {
            geminiWarning.classList.remove('show');
        }
        if (elements.vramInfo) {
            elements.vramInfo.style.display = 'inline';
        }
        if (elements.modelSelectWrapper) {
            elements.modelSelectWrapper.classList.remove('disabled');
        }
    }
}

// ── 音声認識クライアント（GPU/モデル）状態の表示更新 ──
function updateClientStatus(status) {
    if (isGeminiMode) {
        return;
    }
    // モデルロード中の場合は、他のステータスパケットによる画面書き換え（上書き）を完全にシャットアウト
    if (isModelLoading) {
        console.log("⏳ ロード中ロック中のため、ステータス自動更新をスキップします");
        return;
    }

    cachedClientStatus = status;
    if (!elements.modelSelectWrapper || !elements.vramInfo || !elements.modelOptions) return;
    
    if (!status || !status.hasClient) {
        // 文字起こしクライアントが接続されていない場合
        elements.modelSelectText.textContent = '⚠️ GPUクライアント起動待ち...';
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
    
    if (elements.connectionWarning) {
        if (connected) {
            elements.connectionWarning.classList.remove('show');
        } else {
            elements.connectionWarning.classList.add('show');
        }
    }
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
    if (!leaveBtn) return;
    
    // ホストPC自身（localhost / 127.0.0.1 / ::1）からのアクセスか判定
    const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' || window.location.hostname === '[::1]' || window.location.hostname === '::1';
    
    if (!isLocalhost) {
        // 共有先（リモートメンバー）の場合は、退出ボタンを完全に非表示にする
        leaveBtn.style.display = 'none';
        return;
    }
    
    leaveBtn.style.display = isInVoice ? 'inline-flex' : 'none';
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
        document.querySelectorAll('.member-lang-select').forEach(el => el.classList.remove('open'));
    });
}

// 音声言語カスタムセレクトボックスのセットアップ（個別設定に移行したため空）
function setupDetectLangSelect() {
    // グローバル検出言語セレクトは廃止。発言者ごとの設定パネルに移行済み。
}

// ── ボイスメンバーパネルの描画 ──
function renderVoiceMembers() {
    if (!elements.voiceMembersPanel || !elements.voiceMembersList) return;
    
    if (voiceMembers.length === 0) {
        elements.voiceMembersPanel.style.display = 'none';
        return;
    }
    
    elements.voiceMembersPanel.style.display = 'block';
    elements.voiceMembersList.innerHTML = '';
    
    const langChoices = [
        { value: 'auto', label: '🌐 Auto Detect' },
        { value: 'ja', label: '🇯🇵 Japanese' },
        { value: 'en', label: '🇺🇸 English' },
        { value: 'zh', label: '🇨🇳 Chinese' },
        { value: 'ko', label: '🇰🇷 Korean' },
        { value: 'id', label: '🇮🇩 Indonesian' },
        { value: 'yue', label: '🇭🇰 Cantonese' },
        { value: 'es', label: '🇪🇸 Spanish' },
        { value: 'fr', label: '🇫🇷 French' },
        { value: 'de', label: '🇩🇪 German' },
        { value: 'ru', label: '🇷🇺 Russian' },
        { value: 'th', label: '🇹🇭 Thai' },
        { value: 'vi', label: '🇻🇳 Vietnamese' },
    ];
    
    voiceMembers.forEach(member => {
        const card = document.createElement('div');
        card.className = `voice-member-card${member.lang && member.lang !== 'auto' ? ' lang-set' : ''}`;
        card.setAttribute('data-user-id', member.user_id);
        
        // ユーザーカラー
        if (!userColors[member.user_id]) {
            userColors[member.user_id] = colorPalette[colorIndex % colorPalette.length];
            colorIndex++;
        }
        const color = userColors[member.user_id];
        const initial = member.username.charAt(0).toUpperCase();
        
        // アバター
        const avatarHtml = member.avatar_url
            ? `<img class="member-avatar" src="${escapeHtml(member.avatar_url)}" alt="${escapeHtml(member.username)}" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
               <div class="member-avatar-fallback" style="background: ${color}; display: none">${initial}</div>`
            : `<div class="member-avatar-fallback" style="background: ${color}">${initial}</div>`;
        
        // 現在の言語ラベルの構築 (手動・自動制限のビジュアル反映)
        let currentLabel = '🌐 Auto Detect';
        const limitStr = member.active_limit || member.lang || 'auto';
        
        if (limitStr.startsWith('auto:')) {
            // 自動言語制限が機能している状態 (例: "auto:ja,en")
            const autoLangs = limitStr.substring(5).split(',').filter(x => x);
            const flags = autoLangs.map(val => {
                const choice = langChoices.find(c => c.value === val);
                return choice ? choice.label.split(' ')[0] : val.toUpperCase();
            }).join('+');
            currentLabel = `🌐 Auto (${flags})`;
        } else if (limitStr === 'auto') {
            currentLabel = '🌐 Auto Detect';
        } else {
            // 手動で言語制限されている状態 (例: "ja,en")
            const activeLangs = limitStr.split(',').filter(x => x);
            currentLabel = activeLangs.map(val => {
                const choice = langChoices.find(c => c.value === val);
                if (choice) {
                    const flag = choice.label.split(' ')[0];
                    return `${flag} ${val.toUpperCase()}`;
                }
                return val.toUpperCase();
            }).join('+');
        }
        
        // 言語選択オプションの構築 (チェックボックス風)
        const activeLangs = (member.lang || 'auto').split(',').filter(x => x);
        const optionsHtml = langChoices.map(c => {
            const isSelected = activeLangs.includes(c.value);
            return `
                <div class="member-lang-option${isSelected ? ' selected' : ''}" data-value="${c.value}">
                    <span class="checkbox-indicator" style="margin-right: 6px; font-family: monospace;">${isSelected ? '☑️' : '☐'}</span>
                    <span class="option-label">${c.label}</span>
                </div>
            `;
        }).join('');
        
        // 現在のしきい値
        const currentThreshold = member.threshold !== undefined ? member.threshold : 350;
        
        card.innerHTML = `
            ${avatarHtml}
            <div class="member-info-row">
                <span class="member-name" title="${escapeHtml(member.username)}">${escapeHtml(member.username)}</span>
                <div class="member-threshold-control">
                    <span class="threshold-label" title="Noise Gate (音声検出のしきい値。小さい声がカットされる場合は数値を下げてください)">🎚️ <span class="threshold-value">${currentThreshold}</span></span>
                    <input type="range" class="threshold-slider" min="0" max="900" step="25" value="${currentThreshold}" data-user-id="${member.user_id}">
                </div>
            </div>
            <div class="member-lang-select" data-user-id="${member.user_id}">
                <div class="member-lang-trigger">
                    <span class="member-lang-text">${currentLabel}</span>
                    <div class="arrow"></div>
                </div>
                <div class="member-lang-options">
                    ${optionsHtml}
                </div>
            </div>
        `;
        
        elements.voiceMembersList.appendChild(card);
    });
    
    // イベントリスナーの登録
    setupMemberLangSelects();
}

// ── メンバーごとの言語セレクトのイベント処理 ──
function setupMemberLangSelects() {
    // トリガーのクリックで開閉
    document.querySelectorAll('.member-lang-trigger').forEach(trigger => {
        trigger.addEventListener('click', (e) => {
            e.stopPropagation();
            const selectEl = trigger.parentElement;
            
            // 他のメンバーセレクトを閉じる
            document.querySelectorAll('.member-lang-select').forEach(el => {
                if (el !== selectEl) el.classList.remove('open');
            });
            // ヘッダーのセレクトも閉じる
            document.querySelectorAll('.custom-select').forEach(el => el.classList.remove('open'));
            
            selectEl.classList.toggle('open');
        });
    });
    
    // オプションのクリック
    document.querySelectorAll('.member-lang-option').forEach(option => {
        option.addEventListener('click', (e) => {
            e.stopPropagation();
            const selectEl = option.closest('.member-lang-select');
            const userId = selectEl.getAttribute('data-user-id');
            const clickedVal = option.getAttribute('data-value');
            
            const memberData = voiceMembers.find(m => m.user_id === userId);
            if (!memberData) return;
            
            let activeLangs = (memberData.lang || 'auto').split(',').filter(x => x);
            const oldLang = memberData.lang;
            
            // 複数言語対応のトグルロジック
            if (clickedVal === 'auto') {
                activeLangs = ['auto'];
            } else {
                // 'auto'をクリア
                activeLangs = activeLangs.filter(l => l !== 'auto');
                
                if (activeLangs.includes(clickedVal)) {
                    // すでに選択されている場合はトグル解除
                    activeLangs = activeLangs.filter(l => l !== clickedVal);
                    if (activeLangs.length === 0) {
                        activeLangs = ['auto'];
                    }
                } else {
                    // 新規追加。ただし最大2言語まで
                    if (activeLangs.length >= 2) {
                        showToast('最大2つの言語まで同時に選択できます', 'info');
                        return;
                    }
                    activeLangs.push(clickedVal);
                }
            }
            
            const newLangStr = activeLangs.join(',');
            memberData.lang = newLangStr;
            
            // UIの状態をDOMで直接書き換え（ドロップダウンを開いたままにして操作性を向上）
            
            // 1. 各オプションの選択状態（チェックマーク）の更新
            selectEl.querySelectorAll('.member-lang-option').forEach(opt => {
                const val = opt.getAttribute('data-value');
                const isSel = activeLangs.includes(val);
                if (isSel) {
                    opt.classList.add('selected');
                } else {
                    opt.classList.remove('selected');
                }
                const indicator = opt.querySelector('.checkbox-indicator');
                if (indicator) {
                    indicator.textContent = isSel ? '☑️' : '☐';
                }
            });
            
            // 2. トリガー表示ラベルの更新
            let currentLabel = '';
            const langChoices = [
                { value: 'auto', label: '🌐 Auto Detect' },
                { value: 'ja', label: '🇯🇵 Japanese' },
                { value: 'en', label: '🇺🇸 English' },
                { value: 'zh', label: '🇨🇳 Chinese' },
                { value: 'ko', label: '🇰🇷 Korean' },
                { value: 'id', label: '🇮🇩 Indonesian' },
                { value: 'yue', label: '🇭🇰 Cantonese' },
                { value: 'es', label: '🇪🇸 Spanish' },
                { value: 'fr', label: '🇫🇷 French' },
                { value: 'de', label: '🇩🇪 German' },
                { value: 'ru', label: '🇷🇺 Russian' },
                { value: 'th', label: '🇹🇭 Thai' },
                { value: 'vi', label: '🇻🇳 Vietnamese' },
            ];
            if (activeLangs.includes('auto') || activeLangs.length === 0) {
                currentLabel = '🌐 Auto Detect';
            } else {
                currentLabel = activeLangs.map(val => {
                    const choice = langChoices.find(c => c.value === val);
                    if (choice) {
                        const flag = choice.label.split(' ')[0]; // 国旗
                        return `${flag} ${val.toUpperCase()}`;
                    }
                    return val.toUpperCase();
                }).join(' + ');
            }
            selectEl.querySelector('.member-lang-text').textContent = currentLabel;
            
            // 3. カードの枠色（lang-set）の更新
            const card = selectEl.closest('.voice-member-card');
            if (newLangStr !== 'auto' && newLangStr !== '') {
                card.classList.add('lang-set');
            } else {
                card.classList.remove('lang-set');
            }
            
            // WebSocketで送信
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'set_user_lang', user_id: userId, lang: newLangStr }));
                console.log(`🌍 ユーザー ${userId} の検出言語を変更: ${newLangStr}`);
                
                if (oldLang !== newLangStr) {
                    const displayLabel = activeLangs.map(l => {
                        return l === 'auto' ? 'Auto Detect' : (langNames[l] || l);
                    }).join(' + ');
                    const userName = memberData ? memberData.username : 'ユーザー';
                    showToast(`${userName} の検出言語を「${displayLabel}」に設定しました`, 'success');
                }
            }
        });
    });

    // スライダーの入力イベントハンドリング (リアルタイム表示変更 & 変更時のWebSocket送信)
    document.querySelectorAll('.threshold-slider').forEach(slider => {
        const userId = slider.getAttribute('data-user-id');
        const valDisplay = slider.parentElement.querySelector('.threshold-value');
        
        slider.addEventListener('input', () => {
            if (valDisplay) {
                valDisplay.textContent = slider.value;
            }
        });
        
        slider.addEventListener('change', () => {
            const value = parseInt(slider.value, 10);
            const memberData = voiceMembers.find(m => m.user_id === userId);
            if (memberData) {
                memberData.threshold = value;
            }
            
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'set_user_threshold', user_id: userId, threshold: value }));
                console.log(`🎚️ ユーザー ${userId} のしきい値を変更: ${value}`);
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

// ── トースト通知の表示 ──
function showToast(message, type = 'success') {
    let container = document.getElementById('toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toast-container';
        container.className = 'toast-container';
        document.body.appendChild(container);
    }
    
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    
    const icon = type === 'success' ? '✅' : 'ℹ️';
    
    toast.innerHTML = `
        <span class="toast-icon">${icon}</span>
        <span class="toast-message">${escapeHtml(message)}</span>
    `;
    
    container.appendChild(toast);
    
    // 4.3秒後に自動削除 (CSSのアニメーション時間4秒 + フェードアウト0.3秒に合わせる)
    setTimeout(() => {
        toast.remove();
    }, 4300);
}

// ── Discordチャットカードを追加 ──
function addDiscordChatCard(data) {
    if (!elements.discordChatList) return;

    // 「まだメッセージがありません」の初期文をクリア
    const emptyMsg = elements.discordChatList.querySelector('.chat-empty-message');
    if (emptyMsg) emptyMsg.remove();

    const card = document.createElement('div');
    card.className = 'discord-chat-card';

    // ユーザー別のカラーを取得または割り当て
    if (!userColors[data.username]) {
        userColors[data.username] = colorPalette[colorIndex % colorPalette.length];
        colorIndex++;
    }
    const color = userColors[data.username];
    const initial = data.username.charAt(0).toUpperCase();

    const avatarHtml = data.avatar_url
        ? `<img class="chat-avatar" src="${escapeHtml(data.avatar_url)}" alt="${escapeHtml(data.username)}" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
           <div class="chat-avatar-fallback" style="background: ${color}; display: none">${initial}</div>`
        : `<div class="chat-avatar-fallback" style="background: ${color}">${initial}</div>`;

    const translationHtml = data.translated_text
        ? `<div class="chat-translation">
             <div class="chat-trans-text">${escapeHtml(data.translated_text)}</div>
           </div>`
        : `<div class="chat-translation skipped">
             <div class="chat-trans-text">(翻訳不要またはAPIキー未設定)</div>
           </div>`;

    card.innerHTML = `
        <div class="chat-card-top">
            <div class="chat-avatar-wrapper">${avatarHtml}</div>
            <div class="chat-meta">
                <span class="chat-username" style="color: ${color}">${escapeHtml(data.username)}</span>
                <span class="chat-timestamp">${data.timestamp}</span>
            </div>
        </div>
        <div class="chat-card-body">
            <div class="chat-original">${escapeHtml(data.original_text)}</div>
            ${translationHtml}
        </div>
    `;

    // 新しいメッセージを一番上に挿入する
    const firstCard = elements.discordChatList.querySelector('.discord-chat-card');
    if (firstCard) {
        elements.discordChatList.insertBefore(card, firstCard);
    } else {
        elements.discordChatList.appendChild(card);
    }

    // 上限30件で古いカードを切り詰める
    const cards = elements.discordChatList.querySelectorAll('.discord-chat-card');
    if (cards.length > 30) {
        cards[cards.length - 1].remove();
    }
}
