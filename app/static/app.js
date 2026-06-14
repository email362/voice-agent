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
let currentUtterance = null;

const ttsSupported =
  "speechSynthesis" in window && "SpeechSynthesisUtterance" in window;

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

function cancelSpeech() {
  if (!ttsSupported) {
    return;
  }

  currentUtterance = null;
  window.speechSynthesis.cancel();
  setSpeaking(false);
}

function speakReply(text) {
  if (!ttsSupported || !speakReplies.checked || !text) {
    return;
  }

  cancelSpeech();

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 1;
  utterance.pitch = 1;
  utterance.lang = "en-US";
  currentUtterance = utterance;

  utterance.addEventListener("end", () => {
    if (currentUtterance !== utterance) {
      return;
    }

    currentUtterance = null;
    setSpeaking(false);
    setStatus("Ready", "ready");
  });

  utterance.addEventListener("error", () => {
    if (currentUtterance !== utterance) {
      return;
    }

    currentUtterance = null;
    setSpeaking(false);
    setStatus("Ready", "ready");
  });

  setSpeaking(true);
  setStatus("Speaking reply", "working");

  try {
    window.speechSynthesis.speak(utterance);
  } catch (error) {
    if (currentUtterance !== utterance) {
      return;
    }

    currentUtterance = null;
    setSpeaking(false);
    setStatus("Ready", "ready");
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
  cancelSpeech();
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
    setStatus("Ready", "ready");
    speakReply(payload.reply);
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
  cancelSpeech();
  setStatus("Ready", "ready");
});

speakReplies.addEventListener("change", () => {
  if (!speakReplies.checked) {
    cancelSpeech();
    setStatus("Ready", "ready");
  }
});

if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
  recordButton.disabled = true;
  setStatus("Browser recording is not supported", "error");
}

if (!ttsSupported) {
  speakReplies.checked = false;
  speakReplies.disabled = true;
  stopSpeakingButton.disabled = true;
}
