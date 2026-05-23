"""
asr_engine.py - Qwen3-ASR および Faster-Whisper に対応した統合文字起こしエンジン
"""

import os
import wave
import tempfile
import logging
import gc
import torch
from typing import Optional

logger = logging.getLogger(__name__)

class ASREngine:
    def __init__(self, model_id: str = "qwen3"):
        self.model_id = model_id
        self.model = None
        
        # モデルIDと実モデル名のマッピング
        self.model_mapping = {
            "qwen3": "Qwen/Qwen3-ASR-1.7B",
            "whisper_large": "large-v3",
            "whisper_medium": "medium",
            "whisper_small": "small",
            "whisper_base": "base",
            "whisper_tiny": "tiny"
        }

    def load_model(self):
        """
        モデルをVRAM（GPU）にロードする
        """
        if self.model is not None:
            return

        model_name = self.model_mapping.get(self.model_id, self.model_id)
        logger.info(f"🤖 ASRモデル [{self.model_id}] ({model_name}) をロードしています...")

        try:
            if self.model_id == "qwen3":
                from qwen_asr import Qwen3ASRModel
                self.model = Qwen3ASRModel.from_pretrained(
                    model_name,
                    dtype=torch.float16,
                    device_map="cuda:0"
                )
            else:
                from faster_whisper import WhisperModel
                # Faster-Whisper を GPU (float16) でロード
                self.model = WhisperModel(
                    model_name,
                    device="cuda",
                    compute_type="float16"
                )
            logger.info(f"✅ ASRモデル [{self.model_id}] のロードが完了しました")
        except Exception as e:
            logger.error(f"❌ ASRモデル [{self.model_id}] のロードに失敗しました: {e}")
            raise

    def unload_model(self):
        """
        モデルをアンロードし、VRAMメモリを完全に解放する
        """
        if self.model is None:
            return
        
        logger.info(f"🧹 ASRモデル [{self.model_id}] をアンロードしてVRAMメモリを解放します...")
        self.model = None
        
        # メモリ解放のためのGCとCUDAキャッシュのクリア
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
        logger.info("✅ VRAMメモリの解放が完了しました")

    def change_model(self, new_model_id: str):
        """
        別モデルへオンデマンドで動的に切り替える
        """
        if self.model_id == new_model_id and self.model is not None:
            return
        
        logger.info(f"🔄 モデルを [{self.model_id}] から [{new_model_id}] へ切り替えます...")
        self.unload_model()
        self.model_id = new_model_id
        self.load_model()

    def transcribe(self, audio_data: bytes, sample_rate: int = 48000, channels: int = 1,
                   detect_language: Optional[str] = "auto") -> dict:
        """
        音声バイナリを文字起こしする
        """
        if self.model is None:
            self.load_model()

        if len(audio_data) < 3200:
            return {"text": "", "language": ""}

        # 音声データを一時WAVファイルに書き出し
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp_wav:
            tmp_wav_path = tmp_wav.name
            
            with wave.open(tmp_wav_path, 'wb') as wav_file:
                wav_file.setnchannels(channels)
                wav_file.setsampwidth(2) # 16-bit (2 bytes)
                wav_file.setframerate(sample_rate)
                wav_file.writeframes(audio_data)

        try:
            lang_map = {
                "auto": None,
                "ja": "ja",
                "en": "en",
                "zh": "zh",
                "ko": "ko",
                "id": "id"
            }
            lang_code = lang_map.get(detect_language, None)

            if self.model_id == "qwen3":
                # Qwen3-ASR専用の言語パラメータマッピング（英語のフルネーム）
                qwen_lang_map = {
                    "ja": "Japanese",
                    "en": "English",
                    "zh": "Chinese",
                    "ko": "Korean",
                    "id": "Indonesian"
                }
                qwen_lang = qwen_lang_map.get(detect_language, None)
                
                results = self.model.transcribe(
                    audio=tmp_wav_path,
                    language=qwen_lang
                )
                
                if results and len(results) > 0:
                    transcription = results[0]
                    return {
                        "text": transcription.text,
                        "language": transcription.language
                    }
            else:
                # Faster-Whisperでの推論実行
                segments, info = self.model.transcribe(
                    tmp_wav_path,
                    beam_size=5,
                    language=lang_code
                )
                
                # segments(ジェネレータ)からテキストを結合
                text = "".join([segment.text for segment in segments]).strip()
                return {
                    "text": text,
                    "language": info.language
                }

            return {"text": "", "language": ""}
            
        except Exception as e:
            logger.error(f"❌ [{self.model_id}] 推論処理中にエラーが発生しました: {e}")
            return {"text": "", "language": ""}
        finally:
            # 一時ファイルの削除
            try:
                if os.path.exists(tmp_wav_path):
                    os.remove(tmp_wav_path)
            except:
                pass

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    # テスト用
    engine = ASREngine(model_id="whisper_tiny")
    engine.load_model()
    print("ASR Engine Test Ready.")
