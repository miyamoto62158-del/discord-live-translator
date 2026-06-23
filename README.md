# Discord Live Translator 🌐

Discordのボイスチャンネルで行われる会話を、Gemini API (AI Studio) を用いてリアルタイムで文字起こし・翻訳し、Webダッシュボードに表示するシステムです。

すべての音声処理と翻訳がクラウド（Gemini API）で完結するため、ローカルに高性能なGPUやPython環境を構築する必要がなく、Node.jsのみで軽量・高速に動作します。

---

## 🎨 特徴

- 🎤 **Geminiによるリアルタイム文字起こし・翻訳** — ボイスチャンネル内のユーザー音声をGemini Live APIに直接送信し、高精度な文字起こしと自然な翻訳をリアルタイムに提供。
- 👤 **ユーザー別表示＆設定** — 発言者ごとに色分け表示し、個別に言語指定（自動検出 / 日本語 / 英語 / 韓国語 / 中国語など）やノイズゲート閾値を調整可能。
- 🖥️ **Webダッシュボード** — ブラウザで翻訳結果を確認可能。自動追従モードやコンパクトモード、Discordチャット連携表示に対応。
- 💰 **完全無料動作可能** — Google AI Studioの無料枠枠内だけで十分に稼働可能。

---

## 📋 必要な環境

- **OS**: Windows / macOS / Linux
- **Node.js**: v20以上（LTS推奨）
- **Gemini APIキー** (Google AI Studio)
- **Discord Botアカウント**

---

## 🛠️ セットアップ手順

### 1. Node.js のインストール
- [Node.js 公式サイト](https://nodejs.org/) からLTS版をダウンロード・インストールしてください。

### 2. 依存パッケージのインストール
本リポジトリをダウンロード（またはクローン）し、`bot` ディレクトリ内でパッケージをインストールします。
```bash
cd bot
npm install
```

### 3. Discord Bot の作成
1. [Discord Developer Portal](https://discord.com/developers/applications) にアクセス。
2. **「New Application」** を作成。
3. 左メニュー **「Bot」** タブより：
   - **「Reset Token」** をクリックしてボットのトークンをコピー。
   - **Privileged Gateway Intents** セクションの `Message Content Intent` をオンにする。
4. 左メニュー **「OAuth2」→「URL Generator」** より：
   - Scopes: `bot`, `applications.commands` を選択。
   - Bot Permissions: `Connect`, `Speak`, `View Channels`, `Send Messages` を選択。
5. 生成されたURLをブラウザで開き、Botを対象のDiscordサーバーに招待します。

### 4. Gemini API キーの取得
1. [Google AI Studio](https://aistudio.google.com/) にアクセスし、Googleアカウントでログイン。
2. **「Get API key」** から新しいAPIキーを生成し、コピーします。

### 5. 設定ファイル (`.env`) の作成
`bot` ディレクトリ内に `.env` ファイルを作成し、以下のように取得したトークンとキーを設定します。

```env
DISCORD_TOKEN=あなたのDiscordボットトークン
GEMINI_API_KEY=あなたのGemini APIキー
```
*(※ `bot/.env.example` をコピーしてリネームして使うこともできます)*

---

## 🚀 起動方法

### ワンクリック起動 (Windows)
リポジトリのルートにある **`start.bat`** をダブルクリックするだけです。
自動的に最新バージョンの確認、Botサーバーの起動、ブラウザでのダッシュボードの起動（`http://localhost:3000`）を行います。

### 手動起動
ターミナルを開き、以下のコマンドを実行します。
```bash
cd bot
node index.js
```
起動後、ブラウザで `http://localhost:3000` にアクセスしてください。

---

## 💡 使い方

1. Discordのボイスチャンネルに参加します。
2. ボットを招待したサーバーのテキストチャンネルで `/join` スラッシュコマンドを送信します。
3. ボットがボイスチャンネルに参加し、リアルタイムでの音声解析・翻訳が開始されます。
4. ダッシュボード上に会話のログがリアルタイムで流れます。
5. 終了する際は `/leave` コマンドを送信してボットを退出させてください。

### コマンド一覧
| コマンド | 説明 |
|---|---|
| `/join` | ボットを現在のボイスチャンネルに参加させ、文字起こし・翻訳を開始します |
| `/leave` | ボットをボイスチャンネルから退出させます |
| `/lang <言語コード>` | 翻訳先言語を変更します（例: `ja`, `en`, `ko` など） |
| `/status` | ボットの接続状況や動作ステータスを確認します |

---

## 📄 ライセンス

本プロジェクトは [MIT License](./LICENSE) の下で公開されています。
