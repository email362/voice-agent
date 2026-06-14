const recordButton = document.querySelector("#recordButton");
const statusDot = document.querySelector("#statusDot");
const statusText = document.querySelector("#statusText");
const transcript = document.querySelector("#transcript");
const metadata = document.querySelector("#metadata");

let mediaRecorder = null;
let mediaStream = null;
let audioChunks = [];
let isRecording = false;

function setStatus(message, state = "ready") {
  statusText.textContent = message;
  statusDot.className = `status-dot is-${state}`;
}

function setTranscript(text, isPlaceholder = false) {
  transcript.textContent = text;
  transcript.classList.toggle("transcript-placeholder", isPlaceholder);
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
    metadata.textContent = [
      payload.language ? `Language: ${payload.language}` : null,
      `Audio: ${payload.duration_seconds}s`,
      `Processed: ${payload.processing_seconds}s`,
    ]
      .filter(Boolean)
      .join(" | ");
    setStatus("Ready", "ready");
  } catch (error) {
    setTranscript(error.message, false);
    metadata.textContent = "";
    setStatus("Error", "error");
  } finally {
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
    setStatus("Microphone unavailable", "error");
    recordButton.textContent = "Start Recording";
    recordButton.classList.remove("is-recording");
  }
});

if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
  recordButton.disabled = true;
  setStatus("Browser recording is not supported", "error");
}
