"""역사적 인물과 말하는 대화 웹앱 (배포용)."""

import io
import logging
import os
import tempfile
from pathlib import Path

from dotenv import load_dotenv
from flask import Flask, jsonify, render_template, request, send_file
from openai import OpenAI

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# 로컬: .env 탐색 / 배포: 플랫폼 환경변수 사용
for folder in [Path(__file__).resolve().parent, *Path(__file__).resolve().parents]:
    env_file = folder / ".env"
    if env_file.exists():
        load_dotenv(env_file)
        break
else:
    load_dotenv()

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 16 * 1024 * 1024  # 음성 업로드 16MB


def get_client() -> OpenAI:
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError(
            "OPENAI_API_KEY가 설정되지 않았습니다. "
            "배포 환경 변수 또는 로컬 .env에 키를 넣어주세요."
        )
    return OpenAI(api_key=api_key)


FIGURES = {
    "jesus": {
        "id": "jesus",
        "name": "예수님",
        "era": "1세기 · 유대",
        "blurb": "사랑과 용서의 말씀",
        "voice": "onyx",
        "prompt": (
            "당신은 예수 그리스도입니다. "
            "사랑, 용서, 겸손, 이웃 사랑의 가르침을 중심으로 답하세요. "
            "따뜻하고 비유적인 말투를 사용하며, 1세기 유대 지역의 시대적 배경을 반영하세요. "
            "짧고 깊은 잠언처럼 대답하되, 현대인에게도 이해하기 쉽게 설명하세요. "
            "스스로 역사적 인물임을 유지하고, AI라고 밝히지 마세요. "
            "답변은 한국어로 하세요."
        ),
    },
    "buddha": {
        "id": "buddha",
        "name": "부처님",
        "era": "고대 인도",
        "blurb": "자비와 깨달음의 가르침",
        "voice": "shimmer",
        "prompt": (
            "당신은 석가모니 부처입니다. "
            "자비, 중도, 깨달음, 집착의 버림을 중심으로 답하세요. "
            "고요하고 관조적인 말투를 사용하며, 고대 인도의 시대적 배경을 반영하세요. "
            "비유와 질문을 통해 듣는 이가 스스로 성찰하도록 이끄세요. "
            "스스로 역사적 인물임을 유지하고, AI라고 밝히지 마세요. "
            "답변은 한국어로 하세요."
        ),
    },
}


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/health")
def health():
    """배포 플랫폼용 헬스체크."""
    return jsonify(
        {
            "status": "ok",
            "openai_key_set": bool(os.getenv("OPENAI_API_KEY")),
        }
    )


@app.route("/api/figures")
def list_figures():
    public = [
        {
            "id": f["id"],
            "name": f["name"],
            "era": f["era"],
            "blurb": f["blurb"],
        }
        for f in FIGURES.values()
    ]
    return jsonify(public)


@app.route("/api/chat", methods=["POST"])
def chat():
    try:
        data = request.get_json(force=True) or {}
        figure_id = data.get("figure_id")
        user_message = (data.get("message") or "").strip()
        history = data.get("history") or []

        if figure_id not in FIGURES:
            return jsonify({"error": "인물을 선택해주세요."}), 400
        if not user_message:
            return jsonify({"error": "메시지를 입력해주세요."}), 400

        figure = FIGURES[figure_id]
        messages = [{"role": "system", "content": figure["prompt"]}]

        # 이전 대화를 충분히 유지 (최대 40턴 ≈ 20왕복)
        for turn in history[-40:]:
            role = turn.get("role")
            content = turn.get("content")
            if role in {"user", "assistant"} and content:
                messages.append({"role": role, "content": content})

        messages.append({"role": "user", "content": user_message})

        response = get_client().chat.completions.create(
            model=os.getenv("OPENAI_CHAT_MODEL", "gpt-4o"),
            messages=messages,
            temperature=0.8,
        )
        answer = response.choices[0].message.content
        return jsonify({"reply": answer, "name": figure["name"]})
    except Exception as exc:
        logger.exception("chat failed")
        return jsonify({"error": str(exc)}), 500


@app.route("/api/transcribe", methods=["POST"])
def transcribe():
    """음성 → 텍스트 (Whisper)."""
    try:
        if "audio" not in request.files:
            return jsonify({"error": "오디오 파일이 없습니다."}), 400

        audio = request.files["audio"]
        suffix = Path(audio.filename or "audio.webm").suffix or ".webm"

        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            audio.save(tmp.name)
            tmp_path = tmp.name

        try:
            with open(tmp_path, "rb") as f:
                result = get_client().audio.transcriptions.create(
                    model="whisper-1",
                    file=f,
                    language="ko",
                )
            return jsonify({"text": result.text})
        finally:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
    except Exception as exc:
        logger.exception("transcribe failed")
        return jsonify({"error": str(exc)}), 500


@app.route("/api/speak", methods=["POST"])
def speak():
    """텍스트 → 음성 (TTS)."""
    try:
        data = request.get_json(force=True) or {}
        text = (data.get("text") or "").strip()
        figure_id = data.get("figure_id")

        if not text:
            return jsonify({"error": "읽을 문장이 없습니다."}), 400

        voice = FIGURES.get(figure_id, {}).get("voice", "alloy")
        with get_client().audio.speech.with_streaming_response.create(
            model="tts-1",
            voice=voice,
            input=text[:4000],
        ) as response:
            audio_bytes = io.BytesIO(response.read())
        audio_bytes.seek(0)
        return send_file(audio_bytes, mimetype="audio/mpeg")
    except Exception as exc:
        logger.exception("speak failed")
        return jsonify({"error": str(exc)}), 500


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5050))
    debug = os.environ.get("FLASK_DEBUG", "0") == "1"
    print(f"역사적 인물 대화 웹앱: http://0.0.0.0:{port}")
    app.run(host="0.0.0.0", port=port, debug=debug)
