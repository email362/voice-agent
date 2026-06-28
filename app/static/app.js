const recordButton = document.querySelector("#recordButton");
const statusDot = document.querySelector("#statusDot");
const statusText = document.querySelector("#statusText");
const metadata = document.querySelector("#metadata");
const speakReplies = document.querySelector("#speakReplies");
const stopSpeakingButton = document.querySelector("#stopSpeakingButton");
const newConversationButton = document.querySelector("#newConversationButton");
const conversationList = document.querySelector("#conversationList");
const chatMessages = document.querySelector("#chatMessages");
const emptyState = document.querySelector("#emptyState");

let mediaRecorder = null;
let mediaStream = null;
let audioChunks = [];
let isRecording = false;
let assistantStatusTimer = null;
let ttsAbortController = null;
let currentAudio = null;
let currentAudioUrl = null;
let ttsRequestId = 0;
let activeConversationId = null;
let conversations = [];

const ttsPlaybackSupported = "Audio" in window;
let ttsConfigured = ttsPlaybackSupported;

function setStatus(message, state = "ready") {
  statusText.textContent = message;
  statusDot.className = `status-dot is-${state}`;
}

function setSpeaking(isSpeaking) {
  stopSpeakingButton.hidden = !isSpeaking;
  stopSpeakingButton.disabled = !isSpeaking;
}

function setConversationControlsDisabled(isDisabled) {
  newConversationButton.disabled = isDisabled;
  conversationList
    .querySelectorAll("button")
    .forEach((button) => {
      button.disabled = isDisabled;
    });
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

async function fetchJson(url, options = {}, fallback = "Request failed.") {
  const response = await fetch(url, options);
  if (!response.ok) {
    const detail = await getErrorDetail(response, fallback);
    throw new Error(detail);
  }
  return response.json();
}

function formatConversationTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function renderConversationList() {
  conversationList.replaceChildren();

  if (!conversations.length) {
    const empty = document.createElement("p");
    empty.className = "conversation-empty";
    empty.textContent = "No conversations yet.";
    conversationList.append(empty);
    return;
  }

  conversations.forEach((conversation) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "conversation-item";
    button.classList.toggle("is-active", conversation.id === activeConversationId);
    button.disabled = isRecording;
    button.addEventListener("click", () => {
      void selectConversation(conversation.id);
    });

    const title = document.createElement("span");
    title.className = "conversation-title";
    title.textContent = conversation.title || "New Conversation";

    const updated = document.createElement("span");
    updated.className = "conversation-time";
    updated.textContent = formatConversationTime(conversation.updated_at);

    button.append(title, updated);
    conversationList.append(button);
  });
}

function renderChat(conversation) {
  chatMessages.replaceChildren();
  const messages = conversation?.messages || [];
  emptyState.hidden = messages.length > 0;

  messages.forEach((message) => {
    const item = document.createElement("article");
    item.className = `chat-message is-${message.role}`;

    const label = document.createElement("div");
    label.className = "chat-message-label";
    label.textContent = message.role === "assistant" ? "Assistant" : "You";

    const content = document.createElement("p");
    content.textContent = message.content || "";

    item.append(label, content);
    chatMessages.append(item);
  });

  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function renderErrorMessage(message) {
  chatMessages.replaceChildren();
  emptyState.hidden = true;

  const item = document.createElement("article");
  item.className = "chat-message is-error";
  const label = document.createElement("div");
  label.className = "chat-message-label";
  label.textContent = "Error";
  const content = document.createElement("p");
  content.textContent = message;

  item.append(label, content);
  chatMessages.append(item);
}

async function refreshConversations() {
  conversations = await fetchJson(
    "/api/conversations",
    {},
    "Could not load conversations.",
  );
  renderConversationList();
}

async function createConversation({ select = true } = {}) {
  const conversation = await fetchJson(
    "/api/conversations",
    { method: "POST" },
    "Could not create a conversation.",
  );
  await refreshConversations();

  if (select) {
    activeConversationId = conversation.id;
    renderConversationList();
    renderChat(conversation);
    metadata.textContent = "";
  }

  return conversation;
}

async function selectConversation(conversationId) {
  if (conversationId === activeConversationId || isRecording) {
    return;
  }

  stopCurrentSpeech();
  setStatus("Loading conversation", "working");

  try {
    const conversation = await fetchJson(
      `/api/conversations/${encodeURIComponent(conversationId)}`,
      {},
      "Could not load the conversation.",
    );
    activeConversationId = conversation.id;
    renderChat(conversation);
    renderConversationList();
    metadata.textContent = "";
    setStatus("Ready", "ready");
  } catch (error) {
    renderErrorMessage(error.message);
    setStatus("Error", "error");
  }
}

async function ensureActiveConversation() {
  if (activeConversationId) {
    return activeConversationId;
  }

  const conversation = await createConversation();
  return conversation.id;
}

async function initializeConversations() {
  setStatus("Loading conversations", "working");

  try {
    await refreshConversations();
    if (!conversations.length) {
      await createConversation();
    } else {
      await selectConversation(conversations[0].id);
    }
    setStatus("Ready", "ready");
  } catch (error) {
    renderErrorMessage(error.message);
    setStatus("Error", "error");
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
  await ensureActiveConversation();
  metadata.textContent = "";
  setStatus("Recording", "recording");
  recordButton.textContent = "Stop Recording";
  recordButton.classList.add("is-recording");
  setConversationControlsDisabled(true);

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
  if (activeConversationId) {
    formData.append("conversation_id", activeConversationId);
  }

  setStatus("Transcribing with Whisper", "working");
  assistantStatusTimer = window.setTimeout(() => {
    setStatus("Asking assistant", "working");
  }, 1500);

  try {
    const payload = await fetchJson(
      "/api/transcribe",
      {
        method: "POST",
        body: formData,
      },
      "Transcription request failed.",
    );

    activeConversationId = payload.conversation_id;
    renderChat(payload.conversation);
    await refreshConversations();
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
    renderErrorMessage(error.message);
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
    setConversationControlsDisabled(false);
    renderConversationList();
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
    renderErrorMessage(error.message);
    setStatus("Microphone unavailable", "error");
    recordButton.textContent = "Start Recording";
    recordButton.classList.remove("is-recording");
    setConversationControlsDisabled(false);
  }
});

newConversationButton.addEventListener("click", async () => {
  if (isRecording) {
    return;
  }

  stopCurrentSpeech();
  setStatus("Creating conversation", "working");

  try {
    await createConversation();
    setStatus("Ready", "ready");
  } catch (error) {
    renderErrorMessage(error.message);
    setStatus("Error", "error");
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
void initializeConversations();
