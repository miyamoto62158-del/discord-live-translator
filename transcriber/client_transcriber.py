"""
client_transcriber.py - ローカルPC用文字起こしクライアント (ハイブリッド構成用)

起動時に空きVRAMをチェック（5GB以上必須）し、問題なければQwen3-ASRモデルをロード。
その後、クラウドBotのWebSocketサーバーへリバース接続して、音声データの文字起こしを処理します。
※ DeepL翻訳はクラウド側で実行されるため、ローカルPCにDeepLキーは不要です。
"""

import os
import sys
import json
import asyncio
import base64
import logging
import torch
import websockets
from datetime import datetime

# transcriberディレクトリをパスに追加
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from qwen_asr_engine import QwenASREngine

# ── ログ設定 ──
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger(__name__)

# ── 簡易的 .env 読み込み関数 ──
def load_dotenv(env_path):
    if os.path.exists(env_path):
        logger.info(f"📝 設定ファイル {env_path} から環境変数を読み込んでいます...")
        with open(env_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    key, val = line.split("=", 1)
                    os.environ[key.strip()] = val.strip()

# .env の読み込み優先順位:
# 1. transcriber/.env（ローカルクライアント専用設定）
# 2. bot/.env（後方互換性のため）
transcriber_env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
bot_env_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "bot", ".env")

if os.path.exists(transcriber_env_path):
    load_dotenv(transcriber_env_path)
elif os.path.exists(bot_env_path):
    load_dotenv(bot_env_path)
else:
    logger.warning("⚠️ .env ファイルが見つかりません。環境変数またはデフォルト値を使用します。")

# 設定値（ローカルクライアントに必要なのは接続先URLのみ）
CLOUD_BOT_WS_URL = os.environ.get("CLOUD_BOT_WS_URL", "ws://localhost:3000/hybrid")

# ── VRAMチェック関数 ──
def check_vram_requirement():
    """空きVRAMが5GB以上あるかチェックする"""
    if not torch.cuda.is_available():
        return False, 0.0, "NVIDIA GPU (CUDA) が検出されませんでした。CPUのみではリアルタイム推論できません。"
    
    try:
        free_bytes, total_bytes = torch.cuda.mem_get_info()
        free_gb = free_bytes / (1024 ** 3)
        total_gb = total_bytes / (1024 ** 3)
        logger.info(f"📊 [VRAM状況] 空き: {free_gb:.2f} GB / 全体: {total_gb:.2f} GB")
        
        if free_gb < 5.0:
            return False, free_gb, f"空きVRAMが不足しています。現在: {free_gb:.2f} GB (最低 5.0 GB 必要です)"
        
        return True, free_gb, f"VRAMチェッククリア！空き: {free_gb:.2f} GB"
    except Exception as e:
        return False, 0.0, f"CUDAメモリ情報の取得に失敗しました: {e}"

# ── メイン実行クラス ──
class HybridTranscriberClient:
    def __init__(self):
        self.engine = None
        self.transcribe_lock = asyncio.Lock()

    async def initialize_engines(self):
        """Qwen3-ASRモデルをロード"""
        logger.info("--- Qwen3-ASR ハイブリッドクライアント起動 ---")
        logger.info("📌 翻訳はクラウド側で実行されます。ローカルPCでは文字起こし（ASR）のみ行います。")
        
        logger.info("🤖 Qwen3-ASR モデルをVRAMにロード中...")
        self.engine = QwenASREngine()
        self.engine.load_model()
        logger.info("✅ Qwen3-ASR モデルのロード完了")

    async def run(self):
        # 1. 起動前VRAMチェック
        vram_ok, free_gb, vram_msg = check_vram_requirement()
        
        if not vram_ok:
            logger.error(f"🚨 {vram_msg}")
            await self.report_error_to_cloud(vram_msg)
            sys.exit(1)

        # 2. エンジンの初期化
        try:
            await self.initialize_engines()
        except Exception as e:
            err_msg = f"エンジンのロード中に致命的なエラーが発生しました: {e}"
            logger.error(f"🚨 {err_msg}")
            await self.report_error_to_cloud(err_msg)
            sys.exit(1)

        # 3. クラウドBotへの接続ループ
        retry_delay = 5
        while True:
            try:
                logger.info(f"🔌 クラウドBot ({CLOUD_BOT_WS_URL}) に接続しています...")
                async with websockets.connect(CLOUD_BOT_WS_URL, max_size=10 * 1024 * 1024) as ws:
                    logger.info("🔌 クラウドBotとの接続が確立しました。クライアント情報を登録します。")
                    
                    # 登録メッセージを送信
                    await ws.send(json.dumps({
                        "type": "register",
                        "vram_status": "ok",
                        "free_vram_gb": free_gb
                    }))
                    
                    logger.info("🎉 クライアントの登録完了！スタンバイOK。")
                    
                    # メッセージループ
                    async for message in ws:
                        data = json.loads(message)
                        if data.get("type") == "transcribe_request":
                            asyncio.create_task(self.handle_transcribe_request(ws, data))
                            
            except (websockets.exceptions.ConnectionClosed, ConnectionRefusedError, OSError) as e:
                logger.warning(f"❌ クラウドBotとの接続が切断されました、または接続できませんでした ({e})。{retry_delay}秒後に再試行します...")
                await asyncio.sleep(retry_delay)
            except Exception as e:
                logger.error(f"🚨 予期しない接続エラー: {e}")
                await asyncio.sleep(retry_delay)

    async def report_error_to_cloud(self, error_message):
        """VRAM不足などの起動エラーをクラウドBotに通知して終了する"""
        try:
            logger.info("🔌 クラウドBotへエラー情報の通知を試みています...")
            async with websockets.connect(CLOUD_BOT_WS_URL) as ws:
                await ws.send(json.dumps({
                    "type": "register",
                    "vram_status": "error",
                    "error_message": error_message
                }))
                logger.info("✅ エラー情報の送信に成功しました。")
                await asyncio.sleep(1)
        except Exception as e:
            logger.warning(f"⚠️ クラウドBotへエラーを送信できませんでした (Botが未起動の可能性があります): {e}")

    async def handle_transcribe_request(self, ws, request):
        """音声の文字起こしを実行し、WebSocketで結果を返却（翻訳はクラウド側で実行）"""
        try:
            user_id = request["user_id"]
            username = request["username"]
            avatar_url = request["avatar_url"]
            audio_base64 = request["audio_base64"]
            sample_rate = request["sample_rate"]
            channels = request["channels"]
            detect_lang = request.get("detect_lang", "auto")

            # Base64 デコード
            audio_bytes = base64.b64decode(audio_base64)

            # 文字起こし (GPUの衝突を防ぐため、asyncio Lockで保護)
            async with self.transcribe_lock:
                loop = asyncio.get_event_loop()
                result = await loop.run_in_executor(
                    None,
                    lambda: self.engine.transcribe(
                        audio_bytes,
                        sample_rate=sample_rate,
                        channels=channels,
                        detect_language=detect_lang
                    )
                )

            text = result.get("text", "").strip()
            detected_lang = result.get("language", "auto")

            if not text:
                return  # 発言なし

            logger.info(f"🎤 [{username}] {text} (言語: {detected_lang})")

            # クラウドへ文字起こし結果のみ送信（翻訳はクラウドが行う）
            await ws.send(json.dumps({
                "type": "transcription_result",
                "user_id": user_id,
                "username": username,
                "avatar_url": avatar_url,
                "original_text": text,
                "detected_language": detected_lang,
                "timestamp": datetime.now().strftime("%H:%M:%S")
            }))

        except Exception as e:
            logger.error(f"❌ 音声処理中にエラー発生: {e}", exc_info=True)

if __name__ == "__main__":
    client = HybridTranscriberClient()
    try:
        asyncio.run(client.run())
    except KeyboardInterrupt:
        logger.info("🛑 クライアントを終了します。")
