"""
server.py - FastAPI サーバー
 
Discord Bot からの音声データを受け取り、
Qwen3-ASR を使用して文字起こし、DeepL APIを使用して翻訳を行い、WebSocketでダッシュボードに送信
"""
 
import os
import json
import asyncio
import base64
import logging
import threading
from datetime import datetime
from typing import Optional
from contextlib import asynccontextmanager
 
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
 
from qwen_asr_engine import QwenASREngine
from translator import Translator
 
# ── ログ設定 ──
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger(__name__)
 
# ── 設定 ──
DEEPL_API_KEY = os.environ.get("DEEPL_API_KEY", "")
try:
    SERVER_PORT = int(os.environ.get("TRANSCRIBER_PORT", "8765"))
except ValueError:
    logger.warning("TRANSCRIBER_PORT 環境変数が整数ではありません。デフォルトの 8765 を使用します。")
    SERVER_PORT = 8765
 
# ── グローバル ──
engine: Optional[QwenASREngine] = None
translator: Optional[Translator] = None
connected_dashboards: list[WebSocket] = []
dashboard_target_lang: str = "JA"  # Dashboard's preferred target language
dashboard_detect_lang: str = "auto" # Dashboard's preferred detect language for Qwen3-ASR
transcribe_lock = threading.Lock() # GPUスレッドセーフ用ロック
 
# ── ライフサイクル ──
@asynccontextmanager
async def lifespan(app: FastAPI):
    """サーバー起動時にモデルを初期化"""
    global engine, translator
 
    logger.info("--- Qwen3-ASR + DeepL モードで起動中 ---")
 
    try:
        engine = QwenASREngine()
        engine.load_model()
        logger.info("✅ 文字起こしエンジン初期化完了")
    except Exception as e:
        logger.error(f"🚨 文字起こしエンジン初期化失敗: {e}")
        engine = None

    if not DEEPL_API_KEY:
        logger.error("🚨 DEEPL_API_KEY が設定されていません。bot/.env に設定してください。")
    else:
        try:
            translator = Translator(api_key=DEEPL_API_KEY)
            logger.info("✅ 翻訳エンジン初期化完了")
        except Exception as e:
            logger.error(f"🚨 翻訳エンジン初期化失敗: {e}")
            translator = None
 
    logger.info(f"🚀 Transcriber サーバー起動完了 (port: {SERVER_PORT})")
 
    yield
 
    logger.info("🛑 サーバーを停止しています...")
 
 
# ── FastAPI アプリ ──
app = FastAPI(title="Discord Live Translator - Transcriber", lifespan=lifespan)
 
# CORS の設定（ローカルからのアクセスを許可）
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
 
class AudioData(BaseModel):
    user_id: str
    username: str
    avatar_url: str
    audio_base64: str
    sample_rate: int
    channels: int
    target_lang: str
 
# ── WebSocket ──
@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    global dashboard_target_lang, dashboard_detect_lang, allowed_detect_languages
    await websocket.accept()
    connected_dashboards.append(websocket)
    logger.info("💻 ダッシュボードが接続しました")
    
    # Send usage info on connection
    if translator:
        usage_info = translator.get_usage_info()
        try:
            await websocket.send_json({
                "type": "usage",
                "usage": usage_info
            })
        except:
            pass

    try:
        while True:
            data = await websocket.receive_text()
            message = json.loads(data)
            
            # ダッシュボードからの翻訳先言語変更メッセージを処理
            if message.get("type") == "change_target":
                dashboard_target_lang = message.get("lang", "JA")
                logger.info(f"🌍 翻訳先言語を変更しました: {dashboard_target_lang}")
                
            elif message.get("type") == "change_language":
                dashboard_target_lang = message.get("lang")
                logger.info(f"🌐 ダッシュボードから翻訳先言語が変更されました: {dashboard_target_lang}")
            
            elif message.get("type") == "change_detect_lang":
                dashboard_detect_lang = message.get("lang")
                logger.info(f"🎤 ダッシュボードから検出言語が変更されました: {dashboard_detect_lang}")
                
            # ダッシュボードからの検出対象言語変更メッセージを処理
            elif message.get("type") == "change_detect_languages":
                allowed_detect_languages = message.get("languages", [])
                logger.info(f"🔍 検出対象言語を変更しました: {', '.join(allowed_detect_languages) if allowed_detect_languages else '全言語対象'}")
                
    except WebSocketDisconnect:
        connected_dashboards.remove(websocket)
        logger.info("💻 ダッシュボードが切断されました")
 
async def broadcast_transcription(data: dict):
    """接続されているすべてのダッシュボードにデータを送信"""
    if not connected_dashboards:
        return
 
    tasks = []
    for ws in connected_dashboards:
        tasks.append(ws.send_json(data))
    
    await asyncio.gather(*tasks, return_exceptions=True)
 
 
@app.post("/transcribe")
async def transcribe_audio(request: AudioData):
    """
    Botからの音声を受信し、文字起こし＋翻訳を実行してダッシュボードに配信
    """
    global engine, translator
    
    if not engine:
        raise HTTPException(status_code=503, detail="Qwen3-ASR エンジンが初期化されていません")
 
    # Base64 デコード
    try:
        audio_bytes = base64.b64decode(request.audio_base64)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"音声データのデコードに失敗：{e}")
 
    # 音声データが小さすぎる場合はスキップ（雑音対策：0.4秒未満は無視）
    if len(audio_bytes) < 38400:  # 0.4 秒未満 (48000Hz * 2 bytes * 0.4s = 38400)
        return {"status": "skipped", "reason": "audio_too_short"}
 
    # 文字起こし（GPU衝突を防ぐため、スレッドロックを使用して直列実行）
    def do_transcribe():
        with transcribe_lock:
            return engine.transcribe(
                audio_bytes,
                sample_rate=request.sample_rate,
                channels=request.channels,
                detect_language=dashboard_detect_lang
            )

    loop = asyncio.get_event_loop()
    result = await loop.run_in_executor(None, do_transcribe)
 
    # テキストが空の場合はスキップ
    if not result["text"]:
        return {"status": "skipped", "reason": "no_speech_detected"}
 
    stripped = result["text"].strip()
 
    logger.info(f"🎤 [{request.username}] {result['text']}")
 
    # ダッシュボードの翻訳先言語を優先する
    effective_target_lang = dashboard_target_lang or request.target_lang
 
    # 翻訳
    translation_result = None
    if translator and effective_target_lang:
        translation_result = await loop.run_in_executor(
            None,
            lambda: translator.translate(
                text=result["text"],
                target_lang=effective_target_lang,
                source_lang=None
            )
        )
        logger.info(f"   🌐 -> [{effective_target_lang}] {translation_result['translated_text']}")
        usage_info = translator.get_usage_info()
    else:
        usage_info = None
 
    # ダッシュボードへ送信するデータを作成
    response_data = {
        "type": "transcription",
        "user_id": request.user_id,
        "username": request.username,
        "avatar_url": request.avatar_url,
        "original_text": result["text"],
        "detected_language": result["language"], # Gemini APIではautoになる
        "timestamp": datetime.now().strftime("%H:%M:%S"),
    }
 
    if translation_result:
        response_data.update({
            "translated_text": translation_result["translated_text"],
            "target_lang": effective_target_lang,
            "translation_skipped": translation_result.get("skipped", False),
            "deepl_usage": usage_info  # 互換性のためキー名を維持
        })
 
    # ブロードキャスト
    asyncio.create_task(broadcast_transcription(response_data))
 
    return {"status": "success", "text": result["text"]}
 
if __name__ == "__main__":
    import uvicorn
    logger.info(f"Transcriber Server をポート {SERVER_PORT} で起動します...")
    uvicorn.run("server:app", host="0.0.0.0", port=SERVER_PORT, log_level="info", reload=False)