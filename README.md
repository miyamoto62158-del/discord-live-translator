# Discord Live Translator 🌐

Discordのボイスチャンネルで行われる多言語会話を、リアルタイムで文字起こし・翻訳するシステムです。

![System](https://img.shields.io/badge/System-Local_GPU-green) ![Cost](https://img.shields.io/badge/Cost-Free-brightgreen) ![GPU](https://img.shields.io/badge/GPU-RTX_3060-76B900)

## 機能

- 🎤 **リアルタイム文字起こし** — ボイスチャンネルの全ユーザーの発言を自動文字起こし
- 🌐 **自動言語検出** — 英語、日本語、韓国語など30+言語を自動検出
- 📝 **リアルタイム翻訳** — DeepL APIで高品質な翻訳（日本語が特に自然）
- 👤 **ユーザー別表示** — 発言者ごとにアイコン・色分けして表示
- 🖥️ **Webダッシュボード** — ブラウザで結果を表示（画面共有にも最適）
- 💰 **完全無料** — ローカルGPUで音声認識、DeepL無料枠で翻訳

## 必要な環境

- **OS**: Windows 10/11
- **GPU**: NVIDIA RTX 3060 以上（CUDA対応）
- **Node.js**: v20以上（LTS推奨）
- **Python**: 3.10以上
- **CUDA Toolkit**: 11.x 以上

---

## 🌐 ハイブリッド（Oracle Cloud ＆ ローカルGPU）デプロイについて

Botを24時間クラウドで常時稼働させつつ、音声認識（ASR）などの重いGPU処理だけをローカルPCで行う「ハイブリッド構成」でのデプロイ設定を現在進めています。

現在、Oracle Cloud上でのVCNネットワーク設定は完了しており、VMインスタンスのデプロイは空きリソースの関係で一時的に「スタック（Stack）として保留中」となっています。

現在のデプロイ進捗状況と共同開発者向けの引き継ぎ手順の詳細は、[**Oracle Cloud デプロイ状況と引き継ぎガイド (ORACLE_CLOUD_STATUS.md)**](./ORACLE_CLOUD_STATUS.md) を参照してください。

---

## セットアップ手順

### 1. Node.js のインストール

1. https://nodejs.org/ にアクセス
2. **LTS版** をダウンロードしてインストール
3. 確認: `node --version` → v20.x.x が表示されればOK

### 2. Python 依存パッケージのインストール

```bash
cd transcriber
pip install -r requirements.txt
```

> ⚠️ faster-whisperのCUDA対応版が自動インストールされます。
> 初回はCUDAの依存関係で時間がかかることがあります。

### 3. Node.js 依存パッケージのインストール

```bash
cd bot
npm install
```

### 4. Discord Bot の作成

1. [Discord Developer Portal](https://discord.com/developers/applications) にアクセス
2. **「New Application」** をクリック → 名前を入力（例: `LiveTranslator`）
3. 左メニュー **「Bot」** タブ:
   - **「Reset Token」** → トークンをコピー
   - **Privileged Gateway Intents** の `Message Content Intent` を ON
4. 左メニュー **「OAuth2」→「URL Generator」**:
   - Scopes: `bot`
   - Bot Permissions: `Connect`, `Speak`, `View Channels`, `Send Messages`
5. 生成されたURLをブラウザに貼り付けて、サーバーにBotを招待

### 5. DeepL API キーの取得

1. https://www.deepl.com/pro-api にアクセス
2. **API Free** プランで登録（無料）
3. アカウント設定からAPIキーをコピー

### 6. 設定ファイルの編集

`bot/.env` ファイルを開いて、以下を記入:

```
DISCORD_TOKEN=あなたのBotトークン
DEEPL_API_KEY=あなたのDeepL APIキー:fx
```

## 起動方法

### ワンクリック起動

`start.bat` をダブルクリック！

### 手動起動

**ターミナル1: Python Transcriberサーバー**
```bash
cd transcriber
python server.py
```

**ターミナル2: Discord Bot**
```bash
cd bot
node index.js
```

ブラウザで http://localhost:3000 を開く

## 使い方

1. `start.bat` で起動（またはコマンドで手動起動）
2. ダッシュボード (http://localhost:3000) がブラウザで開く
3. Discordのテキストチャンネルで `/join` と入力
4. Botがボイスチャンネルに参加し、文字起こし開始！
5. 終了時は `/leave` でBotを退出させる

### Discord コマンド

| コマンド | 説明 |
|---|---|
| `/join` | Botをボイスチャンネルに参加させる |
| `/leave` | Botをボイスチャンネルから退出させる |
| `/lang <言語>` | 翻訳先言語を変更する |
| `/status` | Botの現在の状態を確認する |

## トラブルシューティング

### 「Whisperモデルのロードに失敗」
- CUDA Toolkitがインストールされているか確認: `nvidia-smi`
- `pip install --upgrade faster-whisper` を試す

### 「Discord Botがログインできない」
- `bot/.env` の `DISCORD_TOKEN` が正しいか確認
- トークンに余分なスペースがないか確認

### 「翻訳されない」
- `bot/.env` の `DEEPL_API_KEY` が正しいか確認
- DeepL APIの月間上限を確認
