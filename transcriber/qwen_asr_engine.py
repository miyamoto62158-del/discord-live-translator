"""
qwen_asr_engine.py - Qwen3-ASR 文字起こしエンジン
"""

import os
import wave
import tempfile
import logging
from typing import Optional

logger = logging.getLogger(__name__)

class QwenASREngine:
    def __init__(self, model_name: str = "Qwen/Qwen3-ASR-1.7B"):
        self.model_name = model_name
        self.model = None

    def load_model(self):
        """
        モデルをGPUにロードする
        """
        if self.model is not None:
            return
        
        logger.info(f"Qwen3-ASR モデル ({self.model_name}) をロードしています...")
        
        try:
            import torch
            from qwen_asr import Qwen3ASRModel
            
            # RTX 3060 で動かすため float16 (または bfloat16) を使用
            self.model = Qwen3ASRModel.from_pretrained(
                self.model_name,
                dtype=torch.float16,
                device_map="cuda:0"
            )
            logger.info("✅ Qwen3-ASR モデルのロード完了")
        except Exception as e:
            logger.error(f"❌ Qwen3-ASR モデルのロードに失敗: {e}")
            raise

    def transcribe(self, audio_data: bytes, sample_rate: int = 48000, channels: int = 1,
                   detect_language: Optional[str] = "auto") -> dict:
        """
        音声を文字起こしする
        """
        if self.model is None:
            self.load_model()

        if len(audio_data) < 3200:
            return {"text": "", "language": ""}

        # 一時ファイルを使用
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp_wav:
            tmp_wav_path = tmp_wav.name
            
            with wave.open(tmp_wav_path, 'wb') as wav_file:
                wav_file.setnchannels(channels)
                wav_file.setsampwidth(2) # 16-bit
                wav_file.setframerate(sample_rate)
                wav_file.writeframes(audio_data)

        try:
            # 言語パラメータの変換
            # Dashboard uses: "auto", "ja", "en", "zh", "ko", "id"
            # Qwen3-ASR expects English names or None: "English", "Japanese", "Chinese", "Korean", "Indonesian"
            lang_map = {
                "auto": None,
                "ja": "Japanese",
                "en": "English",
                "zh": "Chinese",
                "ko": "Korean",
                "id": "Indonesian"
            }
            
            qwen_lang = lang_map.get(detect_language, None)

            # 推論実行
            results = self.model.transcribe(
                audio=tmp_wav_path,
                language=qwen_lang
            )
            
            if results and len(results) > 0:
                transcription = results[0]
                text = transcription.text
                detected_lang = transcription.language
                
                return {
                    "text": text,
                    "language": detected_lang
                }
            else:
                return {"text": "", "language": ""}
        except Exception as e:
            logger.error(f"❌ Qwen3-ASR 推論エラー: {e}")
            return {"text": "", "language": ""}
        finally:
            # 一時ファイルを削除
            try:
                if os.path.exists(tmp_wav_path):
                    os.remove(tmp_wav_path)
            except:
                pass

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    engine = QwenASREngine()
    engine.load_model()
    print("Test ready.")
