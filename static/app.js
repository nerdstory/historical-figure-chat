const lobby = document.getElementById("lobby");
const chatRoom = document.getElementById("chatRoom");
const figureNav = document.getElementById("figureNav");
const messagesEl = document.getElementById("messages");
const composer = document.getElementById("composer");
const userInput = document.getElementById("userInput");
const micBtn = document.getElementById("micBtn");
const micHint = document.getElementById("micHint");
const backBtn = document.getElementById("backBtn");
const chatName = document.getElementById("chatName");
const chatEra = document.getElementById("chatEra");
const autoSpeak = document.getElementById("autoSpeak");
const player = document.getElementById("player");

let figures = [];
let currentFigure = null;
let history = [];
let busy = false;
let mediaRecorder = null;
let recordedChunks = [];

async function loadFigures() {
  const res = await fetch("/api/figures");
  figures = await res.json();
  figureNav.innerHTML = "";

  figures.forEach((fig) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "figure-link";
    btn.innerHTML = `${fig.name}<span class="figure-meta">${fig.era} · ${fig.blurb}</span>`;
    btn.addEventListener("click", () => openChat(fig));
    figureNav.appendChild(btn);
  });
}

function openChat(fig) {
  currentFigure = fig;
  history = [];
  messagesEl.innerHTML = "";
  chatName.textContent = fig.name;
  chatEra.textContent = fig.era;
  lobby.hidden = true;
  chatRoom.hidden = false;
  appendMessage(
    "assistant",
    fig.name,
    `안녕하신가. 나는 ${fig.name}이라 하네. 무엇이든 물어보게.`
  );
  userInput.focus();
}

function backToLobby() {
  stopRecording();
  player.pause();
  chatRoom.hidden = true;
  lobby.hidden = false;
  currentFigure = null;
  history = [];
}

function appendMessage(role, who, text, typing = false) {
  const wrap = document.createElement("article");
  wrap.className = `msg ${role}${typing ? " typing" : ""}`;
  wrap.innerHTML = `<p class="who">${who}</p><p class="bubble"></p>`;
  wrap.querySelector(".bubble").textContent = text;
  messagesEl.appendChild(wrap);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return wrap;
}

async function sendMessage(text) {
  const message = (text || "").trim();
  if (!message || !currentFigure || busy) return;

  busy = true;
  composer.querySelector(".send-btn").disabled = true;
  appendMessage("user", "나", message);
  history.push({ role: "user", content: message });
  userInput.value = "";

  const thinking = appendMessage("assistant", currentFigure.name, "생각을 가다듬는 중이오…", true);

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        figure_id: currentFigure.id,
        message,
        history: history.slice(0, -1),
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "응답 실패");

    thinking.remove();
    appendMessage("assistant", data.name || currentFigure.name, data.reply);
    history.push({ role: "assistant", content: data.reply });

    if (autoSpeak.checked) {
      await speakReply(data.reply);
    }
  } catch (err) {
    thinking.remove();
    appendMessage("assistant", "안내", `오류가 발생했습니다: ${err.message}`);
  } finally {
    busy = false;
    composer.querySelector(".send-btn").disabled = false;
    userInput.focus();
  }
}

async function speakReply(text) {
  try {
    const res = await fetch("/api/speak", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        figure_id: currentFigure.id,
      }),
    });
    if (!res.ok) return;
    const blob = await res.blob();
    player.src = URL.createObjectURL(blob);
    await player.play();
  } catch {
    /* 음성 재생 실패는 무시 */
  }
}

async function startRecording() {
  if (busy || mediaRecorder) return;

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recordedChunks = [];
    mediaRecorder = new MediaRecorder(stream);

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) recordedChunks.push(e.data);
    };

    mediaRecorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      micBtn.classList.remove("recording");
      micHint.hidden = true;

      const blob = new Blob(recordedChunks, { type: mediaRecorder.mimeType || "audio/webm" });
      mediaRecorder = null;
      if (blob.size < 800) return;

      const form = new FormData();
      form.append("audio", blob, "speech.webm");

      micHint.hidden = false;
      micHint.textContent = "목소리를 글로 옮기는 중…";

      try {
        const res = await fetch("/api/transcribe", { method: "POST", body: form });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "음성 인식 실패");
        micHint.hidden = true;
        if (data.text) await sendMessage(data.text);
      } catch (err) {
        micHint.textContent = err.message;
        setTimeout(() => {
          micHint.hidden = true;
          micHint.textContent = "듣고 있습니다… 말씀해 주세요";
        }, 2500);
      }
    };

    mediaRecorder.start();
    micBtn.classList.add("recording");
    micHint.hidden = false;
    micHint.textContent = "듣고 있습니다… 말씀해 주세요 (다시 누르면 전송)";
  } catch {
    micHint.hidden = false;
    micHint.textContent = "마이크 권한을 허용해 주세요.";
    setTimeout(() => {
      micHint.hidden = true;
    }, 2500);
  }
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state === "recording") {
    mediaRecorder.stop();
  }
}

micBtn.addEventListener("click", () => {
  if (mediaRecorder && mediaRecorder.state === "recording") {
    stopRecording();
  } else {
    startRecording();
  }
});

composer.addEventListener("submit", (e) => {
  e.preventDefault();
  sendMessage(userInput.value);
});

backBtn.addEventListener("click", backToLobby);

loadFigures().catch((err) => {
  figureNav.textContent = `인물 목록을 불러오지 못했습니다: ${err.message}`;
});
