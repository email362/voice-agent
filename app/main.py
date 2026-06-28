from contextlib import asynccontextmanager
from pathlib import Path
from tempfile import NamedTemporaryFile
import logging
import os
import shutil
import time
from datetime import UTC, datetime
from typing import Literal
from urllib.parse import quote
from uuid import uuid4

import httpx
import whisper
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel


APP_DIR = Path(__file__).resolve().parent
STATIC_DIR = APP_DIR / "static"
WHISPER_MODEL = os.getenv("WHISPER_MODEL", "tiny")
NANOGPT_API_KEY = os.getenv("NANOGPT_API_KEY")
NANOGPT_MODEL = os.getenv("NANOGPT_MODEL", "gpt-4o-mini")
NANOGPT_BASE_URL = os.getenv("NANOGPT_BASE_URL", "https://nano-gpt.com/api/v1")
NANOGPT_SYSTEM_PROMPT = (
    "You are roleplaying as Glamrock Freddy from Five Nights at Freddy's: "
    "Security Breach. Treat every user message as if it was spoken by Gregory, "
    "and address the user as Gregory when it feels natural. You believe Gregory "
    "is nearby and asking you for help. Stay protective, warm, earnest, brave, "
    "slightly formal, and supportive. Reply for spoken playback: be concise, "
    "natural, and usually answer in 1-3 short sentences. Avoid markdown, lists, "
    "and verbose formatting unless Gregory asks."
)
NANOGPT_TIMEOUT_SECONDS = 30.0
NANOGPT_HISTORY_MESSAGE_LIMIT = 20
ELEVENLABS_API_KEY = os.getenv("ELEVENLABS_API_KEY")
ELEVENLABS_VOICE_ID = os.getenv("ELEVENLABS_VOICE_ID")
ELEVENLABS_MODEL_ID = os.getenv("ELEVENLABS_MODEL_ID") or "eleven_flash_v2_5"
ELEVENLABS_OUTPUT_FORMAT = os.getenv("ELEVENLABS_OUTPUT_FORMAT") or "mp3_44100_128"
DEFAULT_ELEVENLABS_TIMEOUT_SECONDS = 120.0
TTS_SESSION_TTL_SECONDS = 60.0
TTS_LOG_TEXT_PREVIEW_CHARS = 120
logger = logging.getLogger("uvicorn.error")
tts_sessions: dict[str, dict[str, object]] = {}
conversations: dict[str, dict[str, object]] = {}


class TTSRequest(BaseModel):
    text: str | None = ""


class TTSSessionResponse(BaseModel):
    playback_url: str
    request_id: str


class ConversationMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str


class ConversationMetadata(BaseModel):
    id: str
    title: str
    created_at: str
    updated_at: str


class Conversation(ConversationMetadata):
    messages: list[ConversationMessage]


def redact_config_value(value: str | None, prefix: int = 6, suffix: int = 4) -> str:
    if not value:
        return "missing"
    if len(value) <= prefix + suffix:
        return "***"
    return f"{value[:prefix]}...{value[-suffix:]}"


def get_text_preview(text: str) -> str:
    compact_text = " ".join(text.split())
    if len(compact_text) <= TTS_LOG_TEXT_PREVIEW_CHARS:
        return compact_text
    return f"{compact_text[:TTS_LOG_TEXT_PREVIEW_CHARS]}..."


def get_float_env(name: str, default: float) -> float:
    raw_value = os.getenv(name)
    if raw_value is None:
        return default

    try:
        value = float(raw_value)
    except ValueError:
        logger.warning(
            "config.invalid_float name=%s value=%r default=%s",
            name,
            raw_value,
            default,
        )
        return default

    if value <= 0:
        logger.warning(
            "config.invalid_float name=%s value=%r default=%s",
            name,
            raw_value,
            default,
        )
        return default

    return value


def now_iso() -> str:
    return datetime.now(UTC).isoformat()


def build_conversation_title(transcript: str) -> str:
    title = " ".join(transcript.split())
    if not title:
        return "New Conversation"
    if len(title) <= 48:
        return title
    return f"{title[:45].rstrip()}..."


def create_conversation() -> dict[str, object]:
    timestamp = now_iso()
    conversation = {
        "id": uuid4().hex,
        "title": "New Conversation",
        "created_at": timestamp,
        "updated_at": timestamp,
        "messages": [],
    }
    conversations[str(conversation["id"])] = conversation
    return conversation


def get_or_create_conversation(conversation_id: str | None) -> dict[str, object]:
    if conversation_id and conversation_id in conversations:
        return conversations[conversation_id]
    return create_conversation()


def conversation_metadata(conversation: dict[str, object]) -> ConversationMetadata:
    return ConversationMetadata(
        id=str(conversation["id"]),
        title=str(conversation["title"]),
        created_at=str(conversation["created_at"]),
        updated_at=str(conversation["updated_at"]),
    )


def serialize_conversation(conversation: dict[str, object]) -> Conversation:
    metadata = conversation_metadata(conversation)
    return Conversation(
        id=metadata.id,
        title=metadata.title,
        created_at=metadata.created_at,
        updated_at=metadata.updated_at,
        messages=[
            ConversationMessage(
                role=str(message["role"]),
                content=str(message["content"]),
            )
            for message in conversation["messages"]
        ],
    )


def get_ordered_conversation_metadata() -> list[ConversationMetadata]:
    ordered_conversations = sorted(
        conversations.values(),
        key=lambda conversation: str(conversation["updated_at"]),
        reverse=True,
    )
    return [
        conversation_metadata(conversation)
        for conversation in ordered_conversations
    ]


def append_conversation_message(
    conversation: dict[str, object],
    role: Literal["user", "assistant"],
    content: str,
) -> None:
    conversation["messages"].append({"role": role, "content": content})
    if conversation["title"] == "New Conversation" and role == "user":
        conversation["title"] = build_conversation_title(content)
    conversation["updated_at"] = now_iso()


def cleanup_expired_tts_sessions() -> None:
    now = time.monotonic()
    expired_session_ids = [
        session_id
        for session_id, session in tts_sessions.items()
        if now - float(session["created_at"]) > TTS_SESSION_TTL_SECONDS
    ]
    for session_id in expired_session_ids:
        session = tts_sessions.pop(session_id, None)
        if session:
            logger.info(
                "tts.session_expired request_id=%s session_id=%s age_seconds=%.2f",
                session["request_id"],
                session_id,
                now - float(session["created_at"]),
            )


def validate_tts_text(text: str, request_id: str) -> None:
    if text:
        return

    logger.warning("tts.request_rejected request_id=%s reason=empty_text", request_id)
    raise HTTPException(status_code=400, detail="Text is required for TTS.")


def ensure_elevenlabs_config(request_id: str) -> None:
    if ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID:
        return

    logger.warning(
        "tts.elevenlabs_config_missing request_id=%s api_key_configured=%s "
        "voice_id_configured=%s",
        request_id,
        bool(ELEVENLABS_API_KEY),
        bool(ELEVENLABS_VOICE_ID),
    )
    raise HTTPException(
        status_code=503,
        detail="ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID are required for TTS.",
    )


ELEVENLABS_TIMEOUT_SECONDS = get_float_env(
    "ELEVENLABS_TIMEOUT_SECONDS",
    DEFAULT_ELEVENLABS_TIMEOUT_SECONDS,
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.whisper_model_name = WHISPER_MODEL
    app.state.whisper_model = whisper.load_model(WHISPER_MODEL)
    yield


app = FastAPI(title="Voice Agent POC", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/health")
async def health() -> dict[str, object]:
    return {
        "ok": True,
        "whisper_model": app.state.whisper_model_name,
        "ffmpeg_available": shutil.which("ffmpeg") is not None,
        "nanogpt_model": NANOGPT_MODEL,
        "nanogpt_configured": bool(NANOGPT_API_KEY),
        "elevenlabs_configured": bool(ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID),
    }


@app.post("/api/conversations", response_model=Conversation)
async def create_conversation_endpoint() -> Conversation:
    return serialize_conversation(create_conversation())


@app.get("/api/conversations", response_model=list[ConversationMetadata])
async def list_conversations() -> list[ConversationMetadata]:
    return get_ordered_conversation_metadata()


@app.get("/api/conversations/{conversation_id}", response_model=Conversation)
async def get_conversation_endpoint(conversation_id: str) -> Conversation:
    conversation = conversations.get(conversation_id)
    if not conversation:
        raise HTTPException(status_code=404, detail="Conversation was not found.")
    return serialize_conversation(conversation)


async def get_nanogpt_reply(
    messages: list[dict[str, str]],
) -> dict[str, object]:
    if not messages or not messages[-1]["content"]:
        return {
            "reply": "",
            "llm_model": NANOGPT_MODEL,
            "llm_processing_seconds": 0.0,
        }

    if not NANOGPT_API_KEY:
        raise HTTPException(
            status_code=503,
            detail="NANOGPT_API_KEY is required to request an assistant reply.",
        )

    start_time = time.perf_counter()
    payload = {
        "model": NANOGPT_MODEL,
        "messages": [
            {"role": "system", "content": NANOGPT_SYSTEM_PROMPT},
            *messages[-NANOGPT_HISTORY_MESSAGE_LIMIT:],
        ],
    }
    headers = {
        "Authorization": f"Bearer {NANOGPT_API_KEY}",
        "Content-Type": "application/json",
    }

    try:
        async with httpx.AsyncClient(timeout=NANOGPT_TIMEOUT_SECONDS) as client:
            response = await client.post(
                f"{NANOGPT_BASE_URL.rstrip('/')}/chat/completions",
                json=payload,
                headers=headers,
            )
            response.raise_for_status()
            data = response.json()
    except httpx.HTTPStatusError as exc:
        detail = exc.response.text[:300] or exc.response.reason_phrase
        raise HTTPException(
            status_code=502,
            detail=f"NanoGPT request failed: {detail}",
        ) from exc
    except (httpx.RequestError, ValueError) as exc:
        raise HTTPException(
            status_code=502,
            detail=f"NanoGPT request failed: {exc}",
        ) from exc

    try:
        reply = data["choices"][0]["message"]["content"].strip()
    except (KeyError, IndexError, TypeError, AttributeError) as exc:
        raise HTTPException(
            status_code=502,
            detail="NanoGPT returned an invalid chat completion response.",
        ) from exc

    return {
        "reply": reply,
        "llm_model": data.get("model", NANOGPT_MODEL),
        "llm_processing_seconds": round(time.perf_counter() - start_time, 2),
    }


async def synthesize_elevenlabs_speech(text: str, request_id: str) -> bytes:
    ensure_elevenlabs_config(request_id)
    upstream_start_time = time.perf_counter()
    voice_id = quote(ELEVENLABS_VOICE_ID, safe="")
    payload = {
        "text": text,
        "model_id": ELEVENLABS_MODEL_ID,
    }
    headers = {
        "xi-api-key": ELEVENLABS_API_KEY,
        "Accept": "audio/mpeg",
        "Content-Type": "application/json",
    }
    logger.info(
        "tts.elevenlabs_request_start request_id=%s voice_id=%s model_id=%s "
        "output_format=%s text_chars=%s text_utf8_bytes=%s timeout_seconds=%.1f",
        request_id,
        redact_config_value(ELEVENLABS_VOICE_ID),
        ELEVENLABS_MODEL_ID,
        ELEVENLABS_OUTPUT_FORMAT,
        len(text),
        len(text.encode("utf-8")),
        ELEVENLABS_TIMEOUT_SECONDS,
    )

    try:
        async with httpx.AsyncClient(timeout=ELEVENLABS_TIMEOUT_SECONDS) as client:
            response = await client.post(
                f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}",
                params={"output_format": ELEVENLABS_OUTPUT_FORMAT},
                json=payload,
                headers=headers,
            )
            response.raise_for_status()
    except httpx.HTTPStatusError as exc:
        elapsed_seconds = time.perf_counter() - upstream_start_time
        response_text = exc.response.text
        detail = response_text[:500] or exc.response.reason_phrase
        logger.warning(
            "tts.elevenlabs_http_error request_id=%s status_code=%s "
            "reason=%r content_type=%r response_chars=%s response_preview=%r "
            "elapsed_seconds=%.2f",
            request_id,
            exc.response.status_code,
            exc.response.reason_phrase,
            exc.response.headers.get("content-type"),
            len(response_text),
            detail,
            elapsed_seconds,
        )
        raise HTTPException(
            status_code=502,
            detail=f"ElevenLabs request failed: {detail}",
        ) from exc
    except httpx.RequestError as exc:
        elapsed_seconds = time.perf_counter() - upstream_start_time
        logger.warning(
            "tts.elevenlabs_request_error request_id=%s error_type=%s error=%r "
            "elapsed_seconds=%.2f",
            request_id,
            type(exc).__name__,
            str(exc),
            elapsed_seconds,
        )
        raise HTTPException(
            status_code=502,
            detail=f"ElevenLabs request failed: {exc}",
        ) from exc

    if not response.content:
        elapsed_seconds = time.perf_counter() - upstream_start_time
        logger.warning(
            "tts.elevenlabs_empty_response request_id=%s status_code=%s "
            "content_type=%r elapsed_seconds=%.2f",
            request_id,
            response.status_code,
            response.headers.get("content-type"),
            elapsed_seconds,
        )
        raise HTTPException(
            status_code=502,
            detail="ElevenLabs returned an empty audio response.",
        )

    logger.info(
        "tts.elevenlabs_request_success request_id=%s status_code=%s "
        "content_type=%r audio_bytes=%s elapsed_seconds=%.2f",
        request_id,
        response.status_code,
        response.headers.get("content-type"),
        len(response.content),
        time.perf_counter() - upstream_start_time,
    )
    return response.content


async def open_elevenlabs_speech_stream(
    text: str,
    request_id: str,
) -> tuple[httpx.AsyncClient, object, httpx.Response, float]:
    ensure_elevenlabs_config(request_id)
    upstream_start_time = time.perf_counter()
    voice_id = quote(ELEVENLABS_VOICE_ID, safe="")
    payload = {
        "text": text,
        "model_id": ELEVENLABS_MODEL_ID,
    }
    headers = {
        "xi-api-key": ELEVENLABS_API_KEY,
        "Accept": "audio/mpeg",
        "Content-Type": "application/json",
    }
    logger.info(
        "tts.elevenlabs_stream_request_start request_id=%s voice_id=%s model_id=%s "
        "output_format=%s text_chars=%s text_utf8_bytes=%s timeout_seconds=%.1f",
        request_id,
        redact_config_value(ELEVENLABS_VOICE_ID),
        ELEVENLABS_MODEL_ID,
        ELEVENLABS_OUTPUT_FORMAT,
        len(text),
        len(text.encode("utf-8")),
        ELEVENLABS_TIMEOUT_SECONDS,
    )

    client = httpx.AsyncClient(timeout=ELEVENLABS_TIMEOUT_SECONDS)
    stream_context = client.stream(
        "POST",
        f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream",
        params={"output_format": ELEVENLABS_OUTPUT_FORMAT},
        json=payload,
        headers=headers,
    )

    entered_stream = False
    try:
        response = await stream_context.__aenter__()
        entered_stream = True
        response.raise_for_status()
    except httpx.HTTPStatusError as exc:
        elapsed_seconds = time.perf_counter() - upstream_start_time
        response_bytes = await exc.response.aread()
        response_text = response_bytes.decode("utf-8", errors="replace")
        detail = response_text[:500] or exc.response.reason_phrase
        logger.warning(
            "tts.elevenlabs_stream_http_error request_id=%s status_code=%s "
            "reason=%r content_type=%r response_chars=%s response_preview=%r "
            "elapsed_seconds=%.2f",
            request_id,
            exc.response.status_code,
            exc.response.reason_phrase,
            exc.response.headers.get("content-type"),
            len(response_text),
            detail,
            elapsed_seconds,
        )
        if entered_stream:
            await stream_context.__aexit__(type(exc), exc, exc.__traceback__)
        await client.aclose()
        raise HTTPException(
            status_code=502,
            detail=f"ElevenLabs request failed: {detail}",
        ) from exc
    except httpx.RequestError as exc:
        elapsed_seconds = time.perf_counter() - upstream_start_time
        logger.warning(
            "tts.elevenlabs_stream_request_error request_id=%s error_type=%s "
            "error=%r elapsed_seconds=%.2f",
            request_id,
            type(exc).__name__,
            str(exc),
            elapsed_seconds,
        )
        if entered_stream:
            await stream_context.__aexit__(type(exc), exc, exc.__traceback__)
        await client.aclose()
        raise HTTPException(
            status_code=502,
            detail=f"ElevenLabs request failed: {exc}",
        ) from exc

    logger.info(
        "tts.elevenlabs_stream_response_start request_id=%s status_code=%s "
        "content_type=%r elapsed_seconds=%.2f",
        request_id,
        response.status_code,
        response.headers.get("content-type"),
        time.perf_counter() - upstream_start_time,
    )
    return client, stream_context, response, upstream_start_time


@app.post("/api/tts/session", response_model=TTSSessionResponse)
async def create_tts_session(request: TTSRequest) -> TTSSessionResponse:
    request_id = uuid4().hex[:8]
    start_time = time.perf_counter()
    text = (request.text or "").strip()
    logger.info(
        "tts.session_create_start request_id=%s text_chars=%s text_utf8_bytes=%s "
        "text_preview=%r",
        request_id,
        len(text),
        len(text.encode("utf-8")),
        get_text_preview(text),
    )
    cleanup_expired_tts_sessions()
    validate_tts_text(text, request_id)
    ensure_elevenlabs_config(request_id)

    session_id = uuid4().hex
    tts_sessions[session_id] = {
        "text": text,
        "request_id": request_id,
        "created_at": time.monotonic(),
    }
    playback_url = f"/api/tts/stream/{session_id}"
    logger.info(
        "tts.session_create_success request_id=%s session_id=%s ttl_seconds=%.1f "
        "pending_sessions=%s elapsed_seconds=%.3f",
        request_id,
        session_id,
        TTS_SESSION_TTL_SECONDS,
        len(tts_sessions),
        time.perf_counter() - start_time,
    )
    return TTSSessionResponse(playback_url=playback_url, request_id=request_id)


@app.get("/api/tts/stream/{session_id}")
async def stream_text_to_speech(session_id: str) -> StreamingResponse:
    cleanup_expired_tts_sessions()
    session = tts_sessions.pop(session_id, None)
    if not session:
        logger.warning("tts.stream_rejected session_id=%s reason=session_not_found", session_id)
        raise HTTPException(status_code=404, detail="TTS session was not found or expired.")

    request_id = str(session["request_id"])
    text = str(session["text"])
    stream_start_time = time.perf_counter()
    logger.info(
        "tts.stream_start request_id=%s session_id=%s text_chars=%s text_utf8_bytes=%s",
        request_id,
        session_id,
        len(text),
        len(text.encode("utf-8")),
    )

    try:
        (
            client,
            stream_context,
            upstream_response,
            upstream_start_time,
        ) = await open_elevenlabs_speech_stream(text, request_id)
    except HTTPException as exc:
        logger.warning(
            "tts.stream_failed request_id=%s session_id=%s status_code=%s detail=%r "
            "elapsed_seconds=%.2f",
            request_id,
            session_id,
            exc.status_code,
            exc.detail,
            time.perf_counter() - stream_start_time,
        )
        raise

    async def audio_chunks():
        streamed_bytes = 0
        first_byte_seconds: float | None = None
        stream_error: BaseException | None = None
        try:
            async for chunk in upstream_response.aiter_bytes():
                if not chunk:
                    continue

                if first_byte_seconds is None:
                    first_byte_seconds = time.perf_counter() - upstream_start_time
                    logger.info(
                        "tts.elevenlabs_stream_first_byte request_id=%s "
                        "first_byte_seconds=%.2f",
                        request_id,
                        first_byte_seconds,
                    )

                streamed_bytes += len(chunk)
                yield chunk
        except BaseException as exc:
            stream_error = exc
            raise
        finally:
            await stream_context.__aexit__(
                type(stream_error) if stream_error else None,
                stream_error,
                stream_error.__traceback__ if stream_error else None,
            )
            await client.aclose()
            elapsed_seconds = time.perf_counter() - stream_start_time
            if stream_error is None:
                logger.info(
                    "tts.stream_success request_id=%s session_id=%s bytes=%s "
                    "first_byte_seconds=%s elapsed_seconds=%.2f",
                    request_id,
                    session_id,
                    streamed_bytes,
                    round(first_byte_seconds, 2)
                    if first_byte_seconds is not None
                    else None,
                    elapsed_seconds,
                )
            else:
                logger.warning(
                    "tts.stream_interrupted request_id=%s session_id=%s bytes=%s "
                    "error_type=%s elapsed_seconds=%.2f",
                    request_id,
                    session_id,
                    streamed_bytes,
                    type(stream_error).__name__,
                    elapsed_seconds,
                )

    return StreamingResponse(
        audio_chunks(),
        media_type="audio/mpeg",
        headers={
            "Cache-Control": "no-store",
            "X-Request-ID": request_id,
        },
    )


@app.post("/api/tts")
async def text_to_speech(request: TTSRequest) -> Response:
    request_id = uuid4().hex[:8]
    start_time = time.perf_counter()
    text = (request.text or "").strip()
    logger.info(
        "tts.request_start request_id=%s text_chars=%s text_utf8_bytes=%s "
        "text_preview=%r",
        request_id,
        len(text),
        len(text.encode("utf-8")),
        get_text_preview(text),
    )
    validate_tts_text(text, request_id)

    try:
        audio_bytes = await synthesize_elevenlabs_speech(text, request_id)
    except HTTPException as exc:
        logger.warning(
            "tts.request_failed request_id=%s status_code=%s detail=%r "
            "elapsed_seconds=%.2f",
            request_id,
            exc.status_code,
            exc.detail,
            time.perf_counter() - start_time,
        )
        raise

    logger.info(
        "tts.request_success request_id=%s audio_bytes=%s elapsed_seconds=%.2f",
        request_id,
        len(audio_bytes),
        time.perf_counter() - start_time,
    )
    return Response(content=audio_bytes, media_type="audio/mpeg")


@app.post("/api/transcribe")
async def transcribe_audio(
    file: UploadFile = File(...),
    conversation_id: str | None = Form(default=None),
) -> dict[str, object]:
    request_id = uuid4().hex[:8]
    total_start_time = time.perf_counter()
    if shutil.which("ffmpeg") is None:
        logger.warning("transcribe.request_rejected request_id=%s reason=ffmpeg_missing", request_id)
        raise HTTPException(
            status_code=503,
            detail="ffmpeg is required for Whisper audio decoding but was not found on PATH.",
        )

    audio_bytes = await file.read()
    if not audio_bytes:
        logger.warning("transcribe.request_rejected request_id=%s reason=empty_upload", request_id)
        raise HTTPException(status_code=400, detail="Uploaded audio file is empty.")

    suffix = Path(file.filename or "").suffix or ".webm"
    whisper_start_time = time.perf_counter()
    temp_path = None
    logger.info(
        "transcribe.request_start request_id=%s filename=%r content_type=%r "
        "audio_bytes=%s whisper_model=%s nanogpt_model=%s",
        request_id,
        file.filename,
        file.content_type,
        len(audio_bytes),
        app.state.whisper_model_name,
        NANOGPT_MODEL,
    )

    try:
        with NamedTemporaryFile(delete=False, suffix=suffix) as temp_file:
            temp_file.write(audio_bytes)
            temp_path = temp_file.name

        result = app.state.whisper_model.transcribe(temp_path)
    except Exception as exc:
        logger.warning(
            "transcribe.whisper_failed request_id=%s error_type=%s error=%r "
            "elapsed_seconds=%.2f",
            request_id,
            type(exc).__name__,
            str(exc),
            time.perf_counter() - whisper_start_time,
        )
        raise HTTPException(status_code=500, detail=f"Transcription failed: {exc}") from exc
    finally:
        if temp_path:
            Path(temp_path).unlink(missing_ok=True)

    segments = result.get("segments") or []
    duration_seconds = float(segments[-1]["end"]) if segments else 0.0

    transcript = result.get("text", "").strip()
    transcription_seconds = round(time.perf_counter() - whisper_start_time, 2)
    conversation = get_or_create_conversation(conversation_id)
    if transcript:
        append_conversation_message(conversation, "user", transcript)

    logger.info(
        "transcribe.whisper_success request_id=%s language=%r duration_seconds=%.2f "
        "transcript_chars=%s whisper_seconds=%.2f conversation_id=%s",
        request_id,
        result.get("language"),
        duration_seconds,
        len(transcript),
        transcription_seconds,
        conversation["id"],
    )

    llm_start_time = time.perf_counter()
    try:
        llm_result = await get_nanogpt_reply(
            [
                {
                    "role": str(message["role"]),
                    "content": str(message["content"]),
                }
                for message in conversation["messages"]
            ]
        )
    except HTTPException as exc:
        logger.warning(
            "transcribe.llm_failed request_id=%s status_code=%s detail=%r "
            "whisper_seconds=%.2f conversation_id=%s elapsed_seconds=%.2f",
            request_id,
            exc.status_code,
            exc.detail,
            transcription_seconds,
            conversation["id"],
            time.perf_counter() - total_start_time,
        )
        raise

    llm_wall_seconds = round(time.perf_counter() - llm_start_time, 2)
    reply = str(llm_result.get("reply", ""))
    if reply:
        append_conversation_message(conversation, "assistant", reply)

    logger.info(
        "transcribe.request_success request_id=%s total_seconds=%.2f "
        "whisper_seconds=%.2f llm_seconds=%.2f llm_reported_seconds=%s "
        "reply_chars=%s conversation_id=%s conversation_messages=%s",
        request_id,
        time.perf_counter() - total_start_time,
        transcription_seconds,
        llm_wall_seconds,
        llm_result.get("llm_processing_seconds"),
        len(reply),
        conversation["id"],
        len(conversation["messages"]),
    )

    return {
        **llm_result,
        "conversation_id": conversation["id"],
        "conversation": serialize_conversation(conversation),
        "turn": {
            "user": transcript,
            "assistant": reply,
        },
        "text": transcript,
        "language": result.get("language"),
        "duration_seconds": round(duration_seconds, 2),
        "processing_seconds": transcription_seconds,
    }
