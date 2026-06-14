const recordButton = document.querySelector("#recordButton");
const statusDot = document.querySelector("#statusDot");
const statusText = document.querySelector("#statusText");
const transcript = document.querySelector("#transcript");
const assistantReply = document.querySelector("#assistantReply");
const metadata = document.querySelector("#metadata");

let mediaRecorder = null;
let mediaStream = null;
let audioChunks = [];
let isRecording = false;
let assistantStatusTimer = null;

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
    setAssistantReply(payload.reply || "(No assistant reply)");
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

if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
  recordButton.disabled = true;
  setStatus("Browser recording is not supported", "error");
}
