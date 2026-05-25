"""
client_transcriber.py - ローカルPC用文字起こしクライアント (即時接続・モデル進捗可視化版)

起動時にまずBotサーバーへWebSocket接続を確立し、ダッシュボードに「ロード中」の進捗を即時表示させた状態で、
最適な初期文字起こしモデル（Qwen3-ASR または Faster-Whisper）のダウンロードとロードを実行します。
これにより、モデル起動待ちの状態が完全に可視化され、手動でのモデル再選択は一切不要になります。
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

from asr_engine import ASREngine

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
transcriber_env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
bot_env_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "bot", ".env")

if os.path.exists(transcriber_env_path):
    load_dotenv(transcriber_env_path)
elif os.path.exists(bot_env_path):
    load_dotenv(bot_env_path)
else:
    logger.warning("⚠️ .env ファイルが見つかりません。環境変数またはデフォルト値を使用します。")

# 設定値
CLOUD_BOT_WS_URL = os.environ.get("CLOUD_BOT_WS_URL", "ws://localhost:3000/hybrid")

# ── 音声認識モデルリスト ──
ALL_MODELS = [
    {"id": "qwen3", "name": "Qwen3-ASR-1.7B (必要VRAM: 5.0GB・推奨)", "req_vram": 5.0},
    {"id": "whisper_large", "name": "Whisper Large-v3 (必要VRAM: 3.0GB)", "req_vram": 3.0},
    {"id": "whisper_medium", "name": "Whisper Medium (必要VRAM: 1.5GB)", "req_vram": 1.5},
    {"id": "whisper_small", "name": "Whisper Small (必要VRAM: 0.8GB)", "req_vram": 0.8},
]

# ── VRAMチェック ＆ モデル自動選択 ──
def check_vram_and_select_model():
    """空きVRAMをチェックし、最適なモデルを選択する"""
    if not torch.cuda.is_available():
        return False, 0.0, None, [], "NVIDIA GPU (CUDA) が検出されませんでした。CPUのみでの実行はサポートされていません。"
    
    try:
        free_bytes, total_bytes = torch.cuda.mem_get_info()
        free_gb = free_bytes / (1024 ** 3)
        total_gb = total_bytes / (1024 ** 3)
        logger.info(f"📊 [VRAM状況] 空き: {free_gb:.2f} GB / 全体: {total_gb:.2f} GB")
        
        # 利用可能なモデル一覧を判定
        available_models = []
        selected_model_id = None
        
        for model in ALL_MODELS:
            if free_gb >= model["req_vram"]:
                available_models.append(model)
                if selected_model_id is None:
                    selected_model_id = model["id"]  # 動作可能な最も上位のモデルをデフォルトにする
        
        if not selected_model_id:
            # 最小のモデル (Whisper Small - 0.8GB) すら動かせない場合
            return False, free_gb, None, [], f"空きVRAMが不足しています。現在: {free_gb:.2f} GB (最小モデルの起動には 0.8 GB 以上の空きVRAMが必要です)"
        
        selected_name = next(m["name"] for m in ALL_MODELS if m["id"] == selected_model_id)
        logger.info(f"✨ VRAM判定による自動選択モデル: [{selected_model_id}] - {selected_name}")
        
        return True, free_gb, selected_model_id, available_models, f"VRAMチェッククリア！(空き: {free_gb:.2f} GB)"
    except Exception as e:
        return False, 0.0, None, [], f"CUDAメモリ情報の取得に失敗しました: {e}"

# ── メイン実行クラス ──
class HybridTranscriberClient:
    def __init__(self):
        self.engine = None
        self.current_model_id = None
        self.available_models = []
        self.free_vram_gb = 0.0
        self.transcribe_lock = asyncio.Lock()

    async def initialize_engines(self, model_id: str):
        """指定されたモデルでASRエンジンをロード"""
        logger.info(f"🤖 ASRモデル [{model_id}] の初期化を開始します...")
        
        loop = asyncio.get_event_loop()
        if self.engine is None:
            self.engine = ASREngine(model_id=model_id)
            # スレッドプールで重いモデルロード処理を実行してイベントループのブロッキングを防ぐ
            await loop.run_in_executor(None, self.engine.load_model)
        else:
            await loop.run_in_executor(None, lambda: self.engine.change_model(model_id))
            
        self.current_model_id = model_id
        logger.info(f"✅ ASRモデル [{model_id}] のロードが完了しました")

    async def run(self):
        # 1. 起動前VRAMチェックとモデルの自動決定
        vram_ok, free_gb, initial_model_id, available_models, vram_msg = check_vram_and_select_model()
        
        if not vram_ok:
            logger.error(f"🚨 {vram_msg}")
            await self.report_error_to_cloud(vram_msg)
            sys.exit(1)

        self.free_vram_gb = free_gb
        self.available_models = available_models
        self.current_model_id = initial_model_id

        # 2. 接続ループに入り、接続後にエンジンを非同期ロードする
        retry_delay = 5
        while True:
            try:
                logger.info(f"🔌 Botサーバー ({CLOUD_BOT_WS_URL}) に接続しています...")
                async with websockets.connect(CLOUD_BOT_WS_URL, max_size=10 * 1024 * 1024) as ws:
                    logger.info("🔌 Botサーバーとの接続が確立しました。")
                    
                    # エンジンが未ロードの場合、まず「ロード中」ステータスで仮登録
                    if self.engine is None:
                        logger.info(f"⏳ 初期モデル [{initial_model_id}] のロード準備中ステータスを送信します...")
                        await ws.send(json.dumps({
                            "type": "register",
                            "vram_status": "loading",
                            "free_vram_gb": self.free_vram_gb,
                            "available_models": self.available_models,
                            "current_model": self.current_model_id
                        }))
                        
                        # UI側が「ロード中」状態に遷移する時間を確保
                        await asyncio.sleep(0.3)
                        
                        # 実際にモデルをロード (VRAMに展開)
                        try:
                            await self.initialize_engines(initial_model_id)
                        except Exception as e:
                            err_msg = f"初期エンジンのロード中に致命的なエラーが発生しました: {e}"
                            logger.error(f"🚨 {err_msg}")
                            await ws.send(json.dumps({
                                "type": "register",
                                "vram_status": "error",
                                "error_message": err_msg
                            }))
                            sys.exit(1)
                    
                    # ロード完了ステータスで正式登録
                    await ws.send(json.dumps({
                        "type": "register",
                        "vram_status": "ok",
                        "free_vram_gb": self.free_vram_gb,
                        "available_models": self.available_models,
                        "current_model": self.current_model_id
                    }))
                    
                    logger.info("🎉 クライアントの登録完了！スタンバイOK。")
                    
                    # メッセージループ
                    async for message in ws:
                        data = json.loads(message)
                        msg_type = data.get("type")
                        
                        if msg_type == "transcribe_request":
                            asyncio.create_task(self.handle_transcribe_request(ws, data))
                        elif msg_type == "change_model":
                            asyncio.create_task(self.handle_change_model_request(ws, data))
                            
            except (websockets.exceptions.ConnectionClosed, ConnectionRefusedError, OSError) as e:
                logger.warning(f"❌ Botサーバーとの接続が切断されました、または接続できませんでした ({e})。{retry_delay}秒後に再試行します...")
                await asyncio.sleep(retry_delay)
            except Exception as e:
                logger.error(f"🚨 予期しない接続エラー: {e}")
                await asyncio.sleep(retry_delay)

    async def report_error_to_cloud(self, error_message):
        """起動エラーをBotサーバーに通知して終了する"""
        try:
            logger.info("🔌 Botサーバーへエラー情報の通知を試みています...")
            async with websockets.connect(CLOUD_BOT_WS_URL) as ws:
                await ws.send(json.dumps({
                    "type": "register",
                    "vram_status": "error",
                    "error_message": error_message
                }))
                logger.info("✅ エラー情報の送信に成功しました。")
                await asyncio.sleep(1)
        except Exception as e:
            logger.warning(f"⚠️ Botサーバーへエラーを送信できませんでした (Botが未起動の可能性があります): {e}")

    async def handle_transcribe_request(self, ws, request):
        """音声の文字起こしを実行し、WebSocketで結果を返却"""
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

            # Botサーバーへ文字起こし結果を送信
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

    async def handle_change_model_request(self, ws, request):
        """ダッシュボードからのモデル切り替え要求を処理"""
        new_model_id = request.get("model_id")
        if not new_model_id:
            return
            
        logger.info(f"🔄 モデル切り替えの要求を受信しました: [{new_model_id}]")
        
        try:
            # 1. ロード開始のステータスをBotサーバー経由でブロードキャスト
            await ws.send(json.dumps({
                "type": "model_loading_status",
                "model_id": new_model_id
            }))
            await asyncio.sleep(0.3) # ダッシュボード側がロード中表示を完了する時間を確保
            
            # 実行中の文字起こしと衝突しないよう、Lockを取得して切り替えを行う
            async with self.transcribe_lock:
                loop = asyncio.get_event_loop()
                await loop.run_in_executor(
                    None,
                    lambda: self.engine.change_model(new_model_id)
                )
                self.current_model_id = new_model_id
            
            logger.info(f"✨ モデル切り替えが成功しました: [{new_model_id}]")
            
            # 切り替え完了ステータスをBotサーバー経由でブロードキャスト
            await ws.send(json.dumps({
                "type": "model_changed_status",
                "current_model": self.current_model_id
            }))
            
        except Exception as e:
            logger.error(f"❌ モデル切り替え中にエラーが発生しました: {e}")

if __name__ == "__main__":
    client = HybridTranscriberClient()
    try:
        asyncio.run(client.run())
    except KeyboardInterrupt:
        logger.info("🛑 クライアントを終了します。")
