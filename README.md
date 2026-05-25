# Discord Live Translator 🌐

Discordのボイスチャンネルで行われる多言語会話を、リアルタイムで文字起こし・翻訳するシステムです。

![System](https://img.shields.io/badge/System-Local_GPU-green) ![Cost](https://img.shields.io/badge/Cost-Free-brightgreen) ![GPU](https://img.shields.io/badge/GPU-CUDA_VRAM_2GB%2B-76B900)

## 機能

- 🎤 **リアルタイム文字起こし** — ボイスチャンネルの全ユーザーの発言を自動文字起こし
- 🌐 **自動言語検出** — 英語、日本語、韓国語など30+言語を自動検出
- 📝 **リアルタイム翻訳** — DeepL APIで高品質な翻訳（日本語が特に自然）
- 👤 **ユーザー別表示** — 発言者ごとにアイコン・色分けして表示
- 🖥️ **Webダッシュボード** — ブラウザで結果を表示（画面共有にも最適）
- 💰 **完全無料** — ローカルGPUで音声認識、DeepL無料枠で翻訳

## 必要な環境

- **OS**: Windows 10/11
- **GPU**: NVIDIA CUDA対応GPU (VRAM 2GB以上)
  - *※ 高性能な Qwen3-ASR (必要VRAM 5GB) や Whisper Large (必要VRAM 3GB) の動作にはRTX 3060以上が推奨されますが、**Whisper Small/Medium等の軽量モデルであれば、VRAM 2GB〜4GB程度のエントリークラスGPU（GTX 1050/1650等）でも快適に動作します**。*
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

**ターミナル1: GPU文字起こしクライアント (Local PC)**
```bash
cd transcriber
python client_transcriber.py
```

**ターミナル2: Discord Bot (Cloud or Local Host)**
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

---

## 👥 他のサーバーへBotを追加して使う手順 (マルチサーバー対応)

本システムはマルチサーバーに対応しています。あなたが自身のローカルPCで `start.bat` を起動していれば、**他の誰かのDiscordサーバーでも簡単にリアルタイム翻訳を利用可能**です。

### 1. 招待URLの送付 (あなたの作業)
Bot開発ポータルで生成した「招待URL」を、導入したいサーバーの管理者に送ります。
* **推奨されるURL生成時の権限 (OAuth2 -> URL Generator)**:
  * Scopes: `bot`, `applications.commands` (スラッシュコマンド用)
  * Bot Permissions: `Connect` (接続), `Speak` (発言), `View Channels` (チャンネル表示), `Send Messages` (メッセージ送信), `Embed Links` (リンク埋め込み)

### 2. サーバー管理者が行う作業
サーバー管理者が行う作業は、**送られてきたURLをブラウザで開き、自分のサーバーを選択してBotを招待（追加）するだけ**です。
* 管理者側でのサーバー設定、PCの起動、プログラムの配置などの**技術的な作業は一切不要**です。
* Botが追加されたら、サーバー内の誰でも `/join ` スラッシュコマンドを入力するだけでBotを呼び出せます。

---

## 📺 画面共有（Go Live）不要！各自のブラウザやスマホでダッシュボードを見る方法

ボイスチャンネルに参加しているメンバーが、PCに高負荷をかけて「画面共有（Go Live）」を行う必要はありません！
各メンバーが自分のPCやスマホのブラウザから、リアルタイム翻訳ダッシュボードを直接開くことで、非常に快適かつクリアにログを確認できます。

### メリット：
- **ホストPCの負荷ゼロ**: 画面共有を行わないため、ホストPCのCPU・GPU・ネットワーク帯域への負荷が一切ありません。
- **ブラウザ自動翻訳に完全対応**: 外国人メンバーは、自分のブラウザの自動翻訳機能（Google翻訳など）を使うことで、ダッシュボード上の文字を瞬時に自分の母国語に変換して表示・確認できます。
- **100%安定稼働**: Discord APIのタイムアウトやレート制限に一切干渉されないため、文字起こしが途中で止まることが絶対にありません。
- **各自で自由に見返し**: 過去の会話を各自スクロールして遡ることが可能です。

---

### 📶 【方法 A】同じ Wi-Fi / LAN 内のメンバーに共有する（対面・自宅内など）
同じルーター（Wi-Fi）に接続している家族や友人であれば、以下の手順でアクセス可能です。
1. **ホストPCのローカルIPを調べる**: PowerShell等で `ipconfig` を実行し、「IPv4 アドレス」（例: `192.168.1.50`）を確認します。
2. **メンバーにURLを教える**: メンバーのブラウザ（PCやスマホ）で `http://[ホストPC` のローカルIP]:3000` を開きます。
   *(例: `http://192.168.1.50:3000`)*

---

### 🌎 【方法 B】遠隔地のオンラインメンバー（Discordのフレンド）に共有する
Discordで離れた場所にいるフレンド全員に共有する最も簡単な方法です。アカウント登録や設定は不要です。

1. **共有機能を起動する**:
   プロジェクトのルートにある **`start.bat`** を起動した際、コンソール上に「外部公開URL (localtunnel) を別画面で起動しますか？ [Y/N]」という質問が表示されます。
   そこで **`Y`** を入力してEnterキーを押すことで、自動的に外部公開用のトンネルが別ウィンドウで立ち上がります。
2. **公開URLが自動発行される**:
   コンソールに `your url is: https://XXXX.loca.lt` のようなURLが表示されます。
3. **URLをDiscordチャットに共有する**:
   そのURLをコピーしてDiscordのテキストチャットに貼り、メンバー全員に各自のブラウザで開いてもらいます。

> 💡 **初回アクセス時のヒント (localtunnelのセキュリティ保護)**
> リンクをクリックした際に「localtunnelのセキュリティ確認画面」が表示された場合：
> 1. ホストPCのグローバルIP（[こちら](https://ipv4.icanhazip.com/) などで表示される `XXX.XXX.XXX.XXX` のような数字）を確認します。
> 2. セキュリティ画面の入力欄にそのホストPCのIPを入力し、**「Click to Continue」** ボタンを押すだけで、各自のブラウザでダッシュボードが直接開くようになります！

---

## 🛠️ ASR音声認識モデルの追加・交換手順

将来、QwenやWhisperのより優れた新しいモデルがリリースされた際、または独自の軽量モデルを追加したい場合は、以下の手順で簡単に追加・交換が可能です。

### 1. 必要VRAM（GPUメモリ）の目安
モデルのパラメータサイズに応じて、必要となる空きVRAM容量は以下のようになります。
* **1.5B 〜 2.0Bクラスモデル** (例: `Qwen3-ASR`): **約 5.0 GB**
* **Whisper Largeクラス** (例: `Whisper Large-v3`): **約 3.0 〜 3.5 GB**
* **Whisper Mediumクラス**: **約 1.5 〜 2.0 GB**
* **Whisper Smallクラス**: **約 0.8 〜 1.0 GB**
* **Whisper Tiny / Baseクラス**: **約 0.3 〜 0.5 GB**

### 2. モデルリストへの登録
`transcriber/client_transcriber.py` の `ALL_MODELS` 配列を編集し、新しいモデルの情報を登録します（必要VRAM容量とダッシュボード上の表示名を設定します）。

```python
# transcriber/client_transcriber.py
ALL_MODELS = [
    {"id": "new_model_id", "name": "新しいモデル名 (必要VRAM: X.XGB)", "req_vram": X.X},
    ...
]
```

### 3. モデルロードマッピングの設定
`transcriber/asr_engine.py` 内の `self.model_mapping` 配列に、Hugging Face上のモデルリポジトリIDまたはモデル名を設定します。

```python
# transcriber/asr_engine.py
self.model_mapping = {
    "new_model_id": "HuggingFace上のID (例: Qwen/Qwen3-ASR-1.7B または large-v3)",
    ...
}
```

* **Whisperモデルの場合**: `WhisperModel("モデル名", ...)` が自動でHugging Faceからモデルをダウンロードします。
* **Qwenモデルなどの別アーキテクチャの場合**: `load_model` メソッド内で `self.model_id == "new_model_id"` 用のロードコード（インポート等）を追加します。

---

## 🌍 音声検出言語の追加手順

新しく対応言語（例：ベトナム語やタイ語など）をダッシュボードに追加したい場合は、以下の3ファイルを変更します。

### 1. ダッシュボードUIへの選択肢の追加 (`dashboard/index.html`)
ヘッダーの「音声言語」セレクタ内に、新しい言語の `<option>` を追加します。

```html
<!-- dashboard/index.html -->
<select id="detect-lang">
    ...
    <option value="vi">🇻🇳 ベトナム語</option>  <!-- 追加 -->
</select>
```

### 2. ASRエンジンへの言語マッピングの追加 (`transcriber/asr_engine.py`)
モデルが解釈できる言語コードとの紐付けを行います。

```python
# transcriber/asr_engine.py
lang_map = {
    "auto": None,
    "ja": "ja",
    "vi": "vi",  # 追加 (Helsinki-NLPやFaster-Whisperで使われるコード)
    ...
}

# Qwen3-ASRを使用する場合の英語フルネームマッピング
qwen_lang_map = {
    "ja": "Japanese",
    "vi": "Vietnamese",  # 追加
    ...
}
```

### 3. ダッシュボードの表示絵文字と名前の設定 (`dashboard/app.js`)
発言カードに表示される国旗絵文字と、言語名を設定します。

```javascript
// dashboard/app.js
const langFlags = {
    'ja': '🇯🇵',
    'vi': '🇻🇳', // 追加
    ...
};

const langNames = {
    'ja': '日本語',
    'vi': 'Tiếng Việt', // 追加
    ...
};
```

## 📄 ライセンス

本プロジェクトは [MIT License](./LICENSE) の下で公開されています。商用・個人利用を問わず、自由に変更・配布が可能です。

