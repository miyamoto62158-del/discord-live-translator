"""
translator.py - DeepL API を使った翻訳モジュール
"""

import logging
import deepl
from typing import Optional

logger = logging.getLogger(__name__)

# 翻訳対応言語（ダッシュボード側と一致させる）
SUPPORTED_LANGUAGES = {
    "JA": "Japanese",
    "EN-US": "English (American)",
    "EN-GB": "English (British)",
    "ZH-HANS": "Chinese (Simplified)",
    "ZH-HANT": "Chinese (Traditional)",
    "KO": "Korean",
    "ES": "Spanish",
    "FR": "French",
    "DE": "German",
    "PT-BR": "Portuguese (Brazilian)",
    "RU": "Russian",
    "ID": "Indonesian",
    "IT": "Italian",
    "NL": "Dutch",
    "PL": "Polish",
    "TR": "Turkish"
}

class Translator:
    """DeepL API を使った翻訳クラス"""

    def __init__(self, api_key: str):
        if not api_key:
            raise ValueError("DEEPL_API_KEY is required for translation.")
        self.translator = deepl.Translator(api_key)
        self.chars_used = 0
        self.chars_limit = 0
        self.update_usage()

    def update_usage(self):
        """DeepLの利用状況（文字数制限など）を取得して更新する"""
        try:
            usage = self.translator.get_usage()
            if usage.any_limit_reached:
                logger.warning("⚠️ DeepL API の翻訳文字数制限に達しました。")
            self.chars_used = usage.character.count
            self.chars_limit = usage.character.limit
        except Exception as e:
            logger.error(f"❌ DeepL 使用量の取得に失敗: {e}")

    def translate(self, text: str, target_lang: str, source_lang: Optional[str] = None) -> dict:
        """
        テキストを翻訳する
        """
        if not text or not text.strip():
            return {"translated_text": "", "source_lang": source_lang or "", "target_lang": target_lang, "chars_used": self.chars_used, "chars_remaining": self.chars_limit - self.chars_used}

        try:
            # DeepLのターゲット言語コードの整形 (EN -> EN-US など)
            if target_lang.upper() == "EN":
                target_lang = "EN-US"
            elif target_lang.upper() == "PT":
                target_lang = "PT-BR"

            # 翻訳先言語がDeepL非対応または同言語の場合はスキップ
            if target_lang.upper() not in SUPPORTED_LANGUAGES:
                return {"translated_text": f"[非対応言語: {target_lang}]", "skipped": True}

            result = self.translator.translate_text(
                text,
                target_lang=target_lang.upper(),
                source_lang=source_lang.upper() if source_lang else None
            )
            
            # 使用量を更新 (APIリクエスト毎にカウントを増やす)
            self.chars_used += len(text)
            
            return {
                "translated_text": result.text,
                "source_lang": result.detected_source_lang,
                "target_lang": target_lang,
                "chars_used": self.chars_used,
                "chars_remaining": self.chars_limit - self.chars_used,
            }
        except deepl.QuotaExceededException:
            logger.error("❌ DeepL クォータ超過")
            return {
                "translated_text": "[翻訳エラー: クォータ制限到達]",
                "error": "QuotaExceeded",
            }
        except Exception as e:
            logger.error(f"❌ DeepL 翻訳エラー: {e}")
            return {
                "translated_text": f"[翻訳エラー: {str(e)}]",
                "error": str(e),
            }

    def get_supported_languages(self) -> dict:
        return SUPPORTED_LANGUAGES

    def get_usage_info(self) -> dict:
        return {
            "chars_used": self.chars_used,
            "chars_limit": self.chars_limit,
            "chars_remaining": self.chars_limit - self.chars_used,
            "usage_percent": (self.chars_used / self.chars_limit * 100) if self.chars_limit > 0 else 0
        }

if __name__ == "__main__":
    import os
    logging.basicConfig(level=logging.INFO)
    api_key = os.environ.get("DEEPL_API_KEY", "")
    if api_key:
        translator = Translator(api_key)
        res = translator.translate("こんにちは世界", "EN-US")
        print(f"Translation: {res['translated_text']}")
    else:
        print("DEEPL_API_KEY not found in environment.")
