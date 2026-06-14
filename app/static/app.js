const recordButton = document.querySelector("#recordButton");
const statusDot = document.querySelector("#statusDot");
const statusText = document.querySelector("#statusText");
const transcript = document.querySelector("#transcript");
const assistantReply = document.querySelector("#assistantReply");
const metadata = document.querySelector("#metadata");
const speakReplies = document.querySelector("#speakReplies");
const stopSpeakingButton = document.querySelector("#stopSpeakingButton");

let mediaRecorder = null;
let mediaStream = null;
let audioChunks = [];
let isRecording = false;
let assistantStatusTimer = null;
let ttsAbortController = null;
let currentAudio = null;
let currentAudioUrl = null;
let ttsRequestId = 0;

const ttsPlaybackSupported =
  "Audio" in window;
let ttsConfigured = ttsPlaybackSupported;

function setStatus(message, state = "ready") {
  statusText.textContent = message;
  statusDot.className = `status-dot is-${state}`;
}

function setTranscript(text, isPlaceholder = false) {
  transcript.textContent = text;
  transcript.classList.toggle("transcript-placeholder", isPlaceholder);
}

function setAssistantReply(text, isPlaceholder = false) {
  assistantReply.textContent = text;
  assistantReply.classList.toggle("transcript-placeholder", isPlaceholder);
}

function setSpeaking(isSpeaking) {
  stopSpeakingButton.hidden = !isSpeaking;
  stopSpeakingButton.disabled = !isSpeaking;
}

function cleanupCurrentAudio() {
  if (currentAudio) {
    currentAudio.pause();
    currentAudio.removeAttribute("src");
    currentAudio.load();
    currentAudio = null;
  }

  if (currentAudioUrl) {
    window.URL.revokeObjectURL(currentAudioUrl);
    currentAudioUrl = null;
  }
}

function stopCurrentSpeech({ abortRequest = true } = {}) {
  ttsRequestId += 1;

  if (abortRequest && ttsAbortController) {
    ttsAbortController.abort();
  }

  ttsAbortController = null;
  cleanupCurrentAudio();
  setSpeaking(false);
}

function finishSpeech(requestId) {
  if (requestId !== ttsRequestId) {
    return;
  }

  ttsRequestId += 1;
  ttsAbortController = null;
  cleanupCurrentAudio();
  setSpeaking(false);
  setStatus("Ready", "ready");
}

async function getErrorDetail(response, fallback) {
  try {
    const payload = await response.json();
    return payload.detail || fallback;
  } catch (error) {
    return fallback;
  }
}

function setTtsAvailable(isAvailable) {
  ttsConfigured = ttsPlaybackSupported && isAvailable;
  speakReplies.disabled = !ttsConfigured;

  if (!ttsConfigured) {
    const hadActiveSpeech = Boolean(ttsAbortController || currentAudio);
    speakReplies.checked = false;
    stopCurrentSpeech();
    if (hadActiveSpeech) {
      setStatus("Ready", "ready");
    }
  }
}

async function loadHealth() {
  if (!ttsPlaybackSupported) {
    setTtsAvailable(false);
    return;
  }

  try {
    const response = await fetch("/health");
    if (!response.ok) {
      return;
    }

    const payload = await response.json();
    setTtsAvailable(Boolean(payload.elevenlabs_configured));
  } catch (error) {
    // Leave TTS enabled if health is unavailable; /api/tts/session failures are non-fatal.
  }
}

async function speakReply(text) {
  if (!ttsConfigured || !speakReplies.checked || !text) {
    return false;
  }

  stopCurrentSpeech();
  const requestId = ++ttsRequestId;
  const controller = new AbortController();
  ttsAbortController = controller;
  setSpeaking(true);
  setStatus("Generating speech", "working");

  try {
    const response = await fetch("/api/tts/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: controller.signal,
    });

    if (requestId !== ttsRequestId) {
      return false;
    }

    if (!response.ok) {
      const detail = await getErrorDetail(response, "TTS request failed.");
      throw new Error(detail);
    }

    const session = await response.json();
    if (requestId !== ttsRequestId) {
      return false;
    }

    if (!session.playback_url) {
      throw new Error("TTS session did not include a playback URL.");
    }

    ttsAbortController = null;
    currentAudio = new Audio(session.playback_url);
    currentAudio.preload = "auto";
    currentAudio.addEventListener("ended", () => finishSpeech(requestId), {
      once: true,
    });
    currentAudio.addEventListener("error", () => finishSpeech(requestId), {
      once: true,
    });
    currentAudio.addEventListener(
      "playing",
      () => {
        if (requestId === ttsRequestId) {
          setStatus("Speaking reply", "working");
        }
      },
      { once: true },
    );

    setStatus("Starting speech", "working");
    await currentAudio.play();
    return true;
  } catch (error) {
    if (requestId !== ttsRequestId || error.name === "AbortError") {
      return false;
    }

    finishSpeech(requestId);
    return false;
  }
}

function getSupportedMimeType() {
  const options = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/ogg;codecs=opus",
  ];

  return options.find((type) => MediaRecorder.isTypeSupported(type)) || "";
}

async function startRecording() {
  stopCurrentSpeech();
  metadata.textContent = "";
  setTranscript("Listening...", true);
  setAssistantReply("Waiting for transcript...", true);
  setStatus("Recording", "recording");
  recordButton.textContent = "Stop Recording";
  recordButton.classList.add("is-recording");

  mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const mimeType = getSupportedMimeType();
  mediaRecorder = new MediaRecorder(
    mediaStream,
    mimeType ? { mimeType } : undefined,
  );

  audioChunks = [];
  mediaRecorder.addEventListener("dataavailable", (event) => {
    if (event.data.size > 0) {
      audioChunks.push(event.data);
    }
  });

  mediaRecorder.addEventListener("stop", uploadRecording);
  mediaRecorder.start();
  isRecording = true;
}

function stopRecording() {
  if (!mediaRecorder || mediaRecorder.state === "inactive") {
    return;
  }

  setStatus("Preparing upload", "working");
  recordButton.disabled = true;
  mediaRecorder.stop();
  mediaStream?.getTracks().forEach((track) => track.stop());
  isRecording = false;
}

async function uploadRecording() {
  const mimeType = mediaRecorder.mimeType || "audio/webm";
  const extension = mimeType.includes("mp4")
    ? "mp4"
    : mimeType.includes("ogg")
      ? "ogg"
      : "webm";
  const audioBlob = new Blob(audioChunks, { type: mimeType });
  const formData = new FormData();

  formData.append("file", audioBlob, `recording.${extension}`);
  setStatus("Transcribing with Whisper", "working");
  assistantStatusTimer = window.setTimeout(() => {
    setStatus("Asking assistant", "working");
  }, 1500);

  try {
    const response = await fetch("/api/transcribe", {
      method: "POST",
      body: formData,
    });

    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.detail || "Transcription request failed.");
    }

    setTranscript(payload.text || "(No speech detected)");
    const replyText = payload.reply || "(No assistant reply)";
    setAssistantReply(replyText, !payload.reply);
    metadata.textContent = [
      payload.language ? `Language: ${payload.language}` : null,
      `Audio: ${payload.duration_seconds}s`,
      `Transcribed: ${payload.processing_seconds}s`,
      payload.llm_model ? `LLM: ${payload.llm_model}` : null,
      payload.llm_processing_seconds
        ? `LLM processed: ${payload.llm_processing_seconds}s`
        : null,
    ]
      .filter(Boolean)
      .join(" | ");
    if (!payload.reply || !speakReplies.checked || !ttsConfigured) {
      setStatus("Ready", "ready");
    }
    void speakReply(payload.reply);
  } catch (error) {
    setTranscript(error.message, false);
    setAssistantReply("Assistant reply unavailable.", true);
    metadata.textContent = "";
    setStatus("Error", "error");
  } finally {
    window.clearTimeout(assistantStatusTimer);
    assistantStatusTimer = null;
    recordButton.disabled = false;
    recordButton.textContent = "Start Recording";
    recordButton.classList.remove("is-recording");
    audioChunks = [];
    mediaRecorder = null;
    mediaStream = null;
  }
}

recordButton.addEventListener("click", async () => {
  if (isRecording) {
    stopRecording();
    return;
  }

  try {
    await startRecording();
  } catch (error) {
    setTranscript(error.message, false);
    setAssistantReply("Assistant reply unavailable.", true);
    setStatus("Microphone unavailable", "error");
    recordButton.textContent = "Start Recording";
    recordButton.classList.remove("is-recording");
  }
});

stopSpeakingButton.addEventListener("click", () => {
  stopCurrentSpeech();
  setStatus("Ready", "ready");
});

speakReplies.addEventListener("change", () => {
  if (!speakReplies.checked) {
    stopCurrentSpeech();
    setStatus("Ready", "ready");
  }
});

if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
  recordButton.disabled = true;
  setStatus("Browser recording is not supported", "error");
}

loadHealth();
