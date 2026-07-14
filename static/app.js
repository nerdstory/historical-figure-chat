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
const clearBtn = document.getElementById("clearBtn");

const STORAGE_KEY = "historical_chat_sessions_v1";

let figures = [];
let currentFigure = null;
/** API 맥락용 [{role, content}, ...] */
let history = [];
/** 화면 표시용 [{role, who, content}, ...] */
let displayLog = [];
let busy = false;
let mediaRecorder = null;
let recordedChunks = [];

function loadSessions() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
  } catch {
    return {};
  }
}

function saveCurrentSession() {
  if (!currentFigure) return;
  const sessions = loadSessions();
  sessions[currentFigure.id] = {
    history,
    displayLog,
    updatedAt: Date.now(),
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));
}

function greetingFor(fig) {
  return `안녕하신가. 나는 ${fig.name}이라 하네. 무엇이든 물어보게.`;
}

async function loadFigures() {
  const res = await fetch("/api/figures");
  figures = await res.json();
  figureNav.innerHTML = "";

  const sessions = loadSessions();

  figures.forEach((fig) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "figure-link";
    const saved = sessions[fig.id];
    const count = saved?.displayLog?.length || 0;
    const extra =
      count > 1
        ? `<span class="figure-meta">${fig.era} · 이전 대화 ${count}개 이어가기</span>`
        : `<span class="figure-meta">${fig.era} · ${fig.blurb}</span>`;
    btn.innerHTML = `${fig.name}${extra}`;
    btn.addEventListener("click", () => openChat(fig));
    figureNav.appendChild(btn);
  });
}

function renderDisplayLog() {
  messagesEl.innerHTML = "";
  displayLog.forEach((item) => {
    appendMessage(item.role, item.who, item.content, false, false);
  });
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function openChat(fig) {
  // 다른 인물 대화 중이었으면 먼저 저장
  if (currentFigure && currentFigure.id !== fig.id) {
    saveCurrentSession();
  }

  currentFigure = fig;
  chatName.textContent = fig.name;
  chatEra.textContent = fig.era;
  lobby.hidden = true;
  chatRoom.hidden = false;

  const saved = loadSessions()[fig.id];
  if (saved && Array.isArray(saved.displayLog) && saved.displayLog.length > 0) {
    history = Array.isArray(saved.history) ? saved.history : [];
    displayLog = saved.displayLog;
    renderDisplayLog();
  } else {
    history = [];
    displayLog = [];
    const greets = greetingFor(fig);
    appendMessage("assistant", fig.name, greets, false, true);
  }

  userInput.focus();
}

function backToLobby() {
  stopRecording();
  player.pause();
  saveCurrentSession();
  chatRoom.hidden = true;
  lobby.hidden = false;
  currentFigure = null;
  loadFigures(); // 이어가기 표시 갱신
}

function clearCurrentChat() {
  if (!currentFigure) return;
  if (!confirm("이 인물과의 대화 기록을 모두 지울까요?")) return;

  history = [];
  displayLog = [];
  messagesEl.innerHTML = "";

  const sessions = loadSessions();
  delete sessions[currentFigure.id];
  localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));

  const greets = greetingFor(currentFigure);
  appendMessage("assistant", currentFigure.name, greets, false, true);
  userInput.focus();
}

function appendMessage(role, who, text, typing = false, persist = true) {
  const wrap = document.createElement("article");
  wrap.className = `msg ${role}${typing ? " typing" : ""}`;
  wrap.innerHTML = `<p class="who">${who}</p><p class="bubble"></p>`;
  wrap.querySelector(".bubble").textContent = text;
  messagesEl.appendChild(wrap);
  messagesEl.scrollTop = messagesEl.scrollHeight;

  if (persist && !typing) {
    displayLog.push({ role, who, content: text });
    saveCurrentSession();
  }
  return wrap;
}

async function sendMessage(text) {
  const message = (text || "").trim();
  if (!message || !currentFigure || busy) return;

  busy = true;
  composer.querySelector(".send-btn").disabled = true;
  appendMessage("user", "나", message, false, true);
  history.push({ role: "user", content: message });
  saveCurrentSession();
  userInput.value = "";

  const thinking = appendMessage(
    "assistant",
    currentFigure.name,
    "생각을 가다듬는 중이오…",
    true,
    false
  );

  try {
    // 인사말 등 화면용만 있는 메시지는 제외하고, user/assistant 턴만 전달
    const context = history.slice(0, -1);

    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        figure_id: currentFigure.id,
        message,
        history: context,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "응답 실패");

    thinking.remove();
    appendMessage("assistant", data.name || currentFigure.name, data.reply, false, true);
    history.push({ role: "assistant", content: data.reply });
    saveCurrentSession();

    if (autoSpeak.checked) {
      await speakReply(data.reply);
    }
  } catch (err) {
    thinking.remove();
    appendMessage("assistant", "안내", `오류가 발생했습니다: ${err.message}`, false, true);
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

      const blob = new Blob(recordedChunks, {
        type: mediaRecorder.mimeType || "audio/webm",
      });
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
if (clearBtn) clearBtn.addEventListener("click", clearCurrentChat);

// 탭 닫기/새로고침 직전에도 저장
window.addEventListener("beforeunload", saveCurrentSession);

loadFigures().catch((err) => {
  figureNav.textContent = `인물 목록을 불러오지 못했습니다: ${err.message}`;
});
