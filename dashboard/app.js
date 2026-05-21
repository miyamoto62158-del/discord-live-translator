/**
 * app.js - ダッシュボードのクライアントサイドスクリプト
 *
 * WebSocketでPython Transcriberサーバーに接続し、
 * リアルタイムの文字起こし・翻訳結果を表示する。
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
    detectLang: document.getElementById('detect-lang'),
    targetLang: document.getElementById('target-lang'),
    messageCount: document.getElementById('message-count'),
    lastUpdate: document.getElementById('last-update'),
    deeplUsage: document.getElementById('deepl-usage'),
    clearBtn: document.getElementById('clear-btn'),
    autoScrollBtn: document.getElementById('auto-scroll-btn'),
};

// ── WebSocket接続 ──
function connect() {
    if (ws && ws.readyState === WebSocket.OPEN) return;
    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
        isConnected = true;
        updateConnectionStatus(true);
        if (elements.targetLang) {
            ws.send(JSON.stringify({ type: 'change_language', lang: elements.targetLang.value }));
        }
        if (elements.detectLang) {
            ws.send(JSON.stringify({ type: 'change_detect_lang', lang: elements.detectLang.value }));
        }
    };

    ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        handleMessage(data);
    };

    ws.onclose = () => {
        isConnected = false;
        updateConnectionStatus(false);
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
            break;
        case 'transcription':
            addTranscriptionCard(data);
            if (data.deepl_usage) {
                updateDeepLUsage(data.deepl_usage);
            }
            break;
    }
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
            <span>(同言語のため翻訳不要)</span>
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
    if (elements.deeplUsage && usage) {
        // X / Y (0.0%) のフォーマットで表示
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
    if (elements.welcome) elements.welcome.style.display = 'flex';
}

// ── 言語変更 ──
function onLanguageChange() {
    const lang = elements.targetLang.value;
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'change_language', lang }));
    }
}

function onDetectLanguageChange() {
    const lang = elements.detectLang.value;
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'change_detect_lang', lang }));
    }
}

// ── ボイスチャンネル操作 ──
let isInVoice = false;

async function joinVoice() {
    const joinBtn = document.getElementById('join-btn');
    const joinBtnWelcome = document.getElementById('join-btn-welcome');

    if (joinBtn) { joinBtn.disabled = true; joinBtn.textContent = '⏳ 接続中...'; }
    if (joinBtnWelcome) { joinBtnWelcome.disabled = true; joinBtnWelcome.textContent = '⏳ 接続中...'; }

    try {
        const res = await fetch('/api/join', { method: 'POST' });
        const data = await res.json();
        if (data.ok) {
            isInVoice = true;
            updateVoiceButtons();
            if (elements.welcome) elements.welcome.style.display = 'none';
            // もしAPIレスポンスに使用状況が入っていれば更新
            if (data.deeplUsage) {
                updateDeepLUsage(data.deeplUsage);
            }
        } else {
            alert(data.error || '参加に失敗しました');
        }
    } catch (e) {
        alert('Botに接続できません。start.batが起動しているか確認してください。');
    }

    if (joinBtn) { joinBtn.disabled = false; joinBtn.textContent = '🎙️ 参加'; }
    if (joinBtnWelcome) { joinBtnWelcome.disabled = false; joinBtnWelcome.textContent = '🎙️ Botを参加させる'; }
}

async function leaveVoice() {
    try {
        await fetch('/api/leave', { method: 'POST' });
        isInVoice = false;
        updateVoiceButtons();
    } catch (e) {}
}

function updateVoiceButtons() {
    const joinBtn = document.getElementById('join-btn');
    const leaveBtn = document.getElementById('leave-btn');
    if (joinBtn) joinBtn.style.display = isInVoice ? 'none' : 'inline-flex';
    if (leaveBtn) leaveBtn.style.display = isInVoice ? 'inline-flex' : 'none';
}


// ── 自動追従トグル ──
function toggleAutoScroll() {
    autoScroll = !autoScroll;
    const btn = elements.autoScrollBtn;
    if (autoScroll) {
        btn.textContent = '📌 自動追従: ON';
        btn.classList.add('active');
        scrollToTop(); // ON にした瞬間は最新へ移動
    } else {
        btn.textContent = '📌 自動追従: OFF';
        btn.classList.remove('active');
    }
}

// ── イベントリスナー ──
elements.clearBtn.addEventListener('click', clearTranscripts);
elements.targetLang.addEventListener('change', onLanguageChange);
if (elements.detectLang) {
    elements.detectLang.addEventListener('change', onDetectLanguageChange);
}
elements.autoScrollBtn.addEventListener('click', toggleAutoScroll);
document.getElementById('join-btn')?.addEventListener('click', joinVoice);
document.getElementById('leave-btn')?.addEventListener('click', leaveVoice);
document.getElementById('join-btn-welcome')?.addEventListener('click', joinVoice);


// ── 起動 ──
connect();

