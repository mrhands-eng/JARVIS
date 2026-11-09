(() => {
  const api = window.jarvis;
  if (!api) {
    document.body.innerHTML =
      '<div style="color:#00e5ff;padding:16px;font-family:Consolas">JARVIS preload failed — restart with npm start</div>';
    return;
  }

  const logEl = document.getElementById("log");
  const statusEl = document.getElementById("status");
  const activityEl = document.getElementById("activity");
  const form = document.getElementById("form");
  let lastActivityKey = "";
  const input = document.getElementById("input");
  const btnMic = document.getElementById("btnMic");
  const btnMute = document.getElementById("btnMute");
  const btnSilence = document.getElementById("btnSilence");
  const btnBrain = document.getElementById("btnBrain");
  const btnStop = document.getElementById("btnStop");
  const confirmBox = document.getElementById("confirm");
  const confirmText = document.getElementById("confirmText");
  const hud = document.getElementById("hud");
  const liveVoiceEl = document.getElementById("liveVoice");
  const remindersHud = document.getElementById("remindersHud");
  const remindersActive = document.getElementById("remindersActive");
  const timerForm = document.getElementById("timerForm");
  const timerMsg = document.getElementById("timerMsg");
  const timerMin = document.getElementById("timerMin");
  const remindersToggle = document.getElementById("remindersToggle");
  const remindersSummaryText = document.getElementById("remindersSummaryText");
  const remindersChevron = document.getElementById("remindersChevron");
  const remindersList = document.getElementById("remindersList");
  const INPUT_PH = "Ask JARVIS… (Ctrl+Shift+J = voice)";

  let muted = false;
  let brainMode = "cursor";
  let recognizing = false;
  let busy = false;
  let audioEl = null;
  let audioUrl = null;
  const audioQueue = [];
  let playing = false;
  /** Bumped on stop — onended / late IPC must not chain the next chunk. */
  let audioGen = 0;
  /** Drop play-audio from cancelled speak() generations. */
  let ttsSuppressAfter = 0;
  let mediaStream = null;
  let audioCtx = null;
  let processor = null;
  let pcmChunks = [];
  let listenTimer = null;
  let liveSttTimer = null;
  let liveSttBusy = false;
  /** In-flight HUD turn: progress lines belong above the live JARVIS bubble. */
  let currentJarvisEl = null;
  let turnLastSystemEl = null;
  const TARGET_RATE = 16000;
  const MAX_LISTEN_MS = 12000;
  const LIVE_STT_MS = 1500;
  const LIVE_STT_MIN_PEAK = 0.003;
  let remindersExpanded = false;
  let remindersCache = [];
  let remindersTick = null;
  const opsRail = document.getElementById("opsRail");
  const opsBody = document.getElementById("opsBody");
  const opsCollapse = document.getElementById("opsCollapse");
  let opsCollapsed = false;

  function formatMb(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1_000_000) return `${Math.round(n / 1024)} КБ`;
    return `${(n / 1_000_000).toFixed(1)} МБ`;
  }

  function pctBar(pct) {
    const p = Math.max(0, Math.min(100, Number(pct) || 0));
    return `<div class="ops-bar"><i style="width:${p}%"></i></div>`;
  }

  function renderOpsPanel(snap) {
    if (!opsBody || !snap) return;
    const parts = [];

    parts.push('<div class="ops-section"><h3>ПК</h3>');
    parts.push(
      `<div class="ops-row">RAM <strong>${snap.ramUsedPct}%</strong> · свободно ${snap.ramFreeGb} ГБ</div>`
    );
    parts.push(`<div class="ops-row">Аптайм <strong>${snap.uptimeMin}</strong> мин</div>`);
    parts.push(
      `<div class="ops-row">Мозг <span class="ops-pill">${snap.brainMode === "local" ? "LOCAL" : "CURSOR"}</span></div>`
    );
    if (snap.selfHealing) {
      parts.push('<div class="ops-row"><strong style="color:#ffe08a">Самолечение</strong></div>');
    }
    parts.push("</div>");

    parts.push('<div class="ops-section"><h3>Голос / STT</h3>');
    parts.push(`<div class="ops-row">TTS: <strong>${snap.voice?.detail || "—"}</strong></div>`);
    const stt = snap.stt || {};
    const sttLabel =
      stt.state === "ready" ? "готово" : stt.state === "loading" ? "загрузка…" : "ожидание";
    parts.push(`<div class="ops-row">STT: <strong>${sttLabel}</strong> · ${stt.model || ""}</div>`);
    parts.push("</div>");

    if (snap.setupScript) {
      const sp = snap.setupScript;
      parts.push('<div class="ops-section"><h3>Скрипт</h3>');
      parts.push(`<div class="ops-job running"><strong>${sp.label}</strong></div>`);
      parts.push(pctBar(sp.pct));
      if (sp.detail) parts.push(`<div class="ops-row">${sp.detail}</div>`);
      parts.push("</div>");
    }

    const assets = (snap.assets || []).filter((a) => !a.ready || a.active);
    if (assets.length) {
      parts.push('<div class="ops-section"><h3>Загрузки</h3>');
      for (const a of assets) {
        const pct = a.expectedBytes ? Math.min(100, Math.round((a.bytes / a.expectedBytes) * 100)) : 0;
        const tag = a.ready ? "готово" : a.active ? "качается…" : pct ? `${pct}%` : "ожидание";
        parts.push(`<div class="ops-row">${a.label} <strong>${tag}</strong> · ${formatMb(a.bytes)}</div>`);
        if (!a.ready && a.expectedBytes) parts.push(pctBar(pct));
      }
      parts.push("</div>");
    }

    const jobs = snap.jobs || [];
    if (jobs.length) {
      parts.push('<div class="ops-section"><h3>Сейчас</h3>');
      for (const j of jobs) {
        const cls = j.status === "running" ? "running" : j.status === "error" ? "error" : "";
        parts.push(`<div class="ops-job ${cls}"><strong>${j.label}</strong></div>`);
        if (j.detail) parts.push(`<div class="ops-row">${j.detail}</div>`);
        if (j.status === "running" && j.progress != null) parts.push(pctBar(j.progress));
        else if (j.progressLabel) parts.push(`<div class="ops-row">${j.progressLabel}</div>`);
      }
      parts.push("</div>");
    }

    if (!jobs.length && !assets.length && !snap.setupScript) {
      parts.push('<div class="ops-section"><div class="ops-row">Фон тихий.</div></div>');
    }

    opsBody.innerHTML = parts.join("");
  }

  async function refreshOpsHud() {
    if (!api.getOpsSnapshot) return;
    try {
      const snap = await api.getOpsSnapshot();
      renderOpsPanel(snap);
    } catch (_) {}
  }

  if (opsCollapse && opsRail) {
    opsCollapse.addEventListener("click", (e) => {
      e.stopPropagation();
      opsCollapsed = !opsCollapsed;
      opsRail.classList.toggle("collapsed", opsCollapsed);
    });
  }

  function formatCountdown(fireAt) {
    const sec = Math.max(0, Math.floor((fireAt - Date.now()) / 1000));
    if (sec < 60) return `через ${sec} сек`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `через ${min} мин`;
    const h = Math.floor(min / 60);
    const m = min % 60;
    return m ? `через ${h} ч ${m} мин` : `через ${h} ч`;
  }

  function formatClock(fireAt) {
    const d = new Date(fireAt);
    const now = new Date();
    const sameDay =
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate();
    if (sameDay) {
      return d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
    }
    return d.toLocaleString("ru-RU", {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function shortMsg(msg, max) {
    const t = String(msg || "").trim();
    const cap = max || 42;
    return t.length > cap ? t.slice(0, cap - 1) + "…" : t;
  }

  function renderRemindersList() {
    if (!remindersList) return;
    remindersList.innerHTML = "";
    for (const r of remindersCache) {
      if (r.fireAt <= Date.now()) continue;
      const li = document.createElement("li");
      li.className = "reminders-item";
      const main = document.createElement("span");
      main.className = "reminders-item-main";
      main.textContent = `${formatClock(r.fireAt)} · ${shortMsg(r.message, 48)} · ${formatCountdown(r.fireAt)}`;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "reminders-dismiss";
      btn.title = "Снять напоминание";
      btn.textContent = "×";
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (api.cancelReminderId) void api.cancelReminderId(r.id).then(() => refreshRemindersHud());
      });
      li.appendChild(main);
      li.appendChild(btn);
      remindersList.appendChild(li);
    }
  }

  async function submitTimerHud(inMinutes) {
    const min = Math.max(1, Math.min(2880, Math.round(Number(inMinutes) || 0)));
    if (!min || !api.scheduleReminderHud) return;
    const msg = timerMsg ? String(timerMsg.value || "").trim() : "";
    try {
      const line = await api.scheduleReminderHud({ message: msg || "Таймер", inMinutes: min });
      append("system", line);
      if (timerMsg && !timerMsg.value.trim()) timerMsg.value = "";
      remindersExpanded = true;
      if (remindersActive) remindersActive.classList.remove("hidden");
      void refreshRemindersHud();
    } catch (e) {
      append("system", "Таймер: " + (e.message || e));
    }
  }

  function renderRemindersSummary() {
    if (!remindersSummaryText) return;
    const active = remindersCache.filter((r) => r.fireAt > Date.now());
    if (!active.length) {
      if (remindersActive) remindersActive.classList.add("hidden");
      if (remindersTick) {
        clearInterval(remindersTick);
        remindersTick = null;
      }
      return;
    }
    if (remindersActive) remindersActive.classList.remove("hidden");
    const next = active[0];
    const n = active.length;
    const extra = n > 1 ? ` (+${n - 1})` : "";
    remindersSummaryText.textContent = `${shortMsg(next.message, 36)}${extra} · ${formatCountdown(next.fireAt)} · ${formatClock(next.fireAt)}`;
    if (remindersExpanded) renderRemindersList();
    if (!remindersTick) {
      remindersTick = setInterval(() => {
        const still = remindersCache.filter((r) => r.fireAt > Date.now());
        if (!still.length) {
          void refreshRemindersHud();
          return;
        }
        renderRemindersSummary();
      }, 1000);
    }
  }

  async function refreshRemindersHud() {
    if (!api.getReminders) return;
    try {
      remindersCache = await api.getReminders();
      renderRemindersSummary();
    } catch (_) {}
  }

  if (remindersToggle && remindersList && remindersChevron) {
    remindersToggle.addEventListener("click", () => {
      remindersExpanded = !remindersExpanded;
      remindersList.classList.toggle("hidden", !remindersExpanded);
      remindersChevron.textContent = remindersExpanded ? "▴" : "▾";
      if (remindersExpanded) renderRemindersList();
    });
  }

  if (timerForm && timerMin) {
    timerForm.addEventListener("submit", (e) => {
      e.preventDefault();
      void submitTimerHud(timerMin.value);
    });
    for (const btn of timerForm.querySelectorAll(".timer-preset")) {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        const m = Number(btn.getAttribute("data-min")) || 5;
        timerMin.value = String(m);
        void submitTimerHud(m);
      });
    }
  }

  function stopAudio(extra) {
    audioGen += 1;
    if (extra && typeof extra.seq === "number") {
      ttsSuppressAfter = Math.max(ttsSuppressAfter, extra.seq);
    }
    audioQueue.length = 0;
    playing = false;
    if (audioEl) {
      try {
        audioEl.pause();
        audioEl.removeAttribute("src");
        audioEl.load();
      } catch (_) {}
      audioEl = null;
    }
    if (audioUrl) {
      try {
        URL.revokeObjectURL(audioUrl);
      } catch (_) {}
      audioUrl = null;
    }
  }

  function playNext() {
    if (playing) return;
    const payload = audioQueue.shift();
    if (!payload) return;
    if (typeof payload.seq === "number" && payload.seq <= ttsSuppressAfter) {
      playNext();
      return;
    }
    const gen = audioGen;
    playing = true;
    try {
      const binary = atob(payload.base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const blob = new Blob([bytes], { type: payload.mime || "audio/mpeg" });
      if (audioUrl) {
        try {
          URL.revokeObjectURL(audioUrl);
        } catch (_) {}
      }
      audioUrl = URL.createObjectURL(blob);
      audioEl = new Audio(audioUrl);
      audioEl.onended = () => {
        if (gen !== audioGen) return;
        playing = false;
        playNext();
      };
      audioEl.onerror = () => {
        if (gen !== audioGen) return;
        playing = false;
        append("system", "Audio play error: decode/playback failed");
        playNext();
      };
      audioEl.play().catch((e) => {
        if (gen !== audioGen) return;
        playing = false;
        append("system", "Audio play error: " + e);
        playNext();
      });
    } catch (e) {
      playing = false;
      append("system", "Audio play error: " + e);
      playNext();
    }
  }

  function playAudio(payload) {
    if (!payload || !payload.base64) return;
    if (typeof payload.seq === "number" && payload.seq <= ttsSuppressAfter) return;
    if (!payload.queue) stopAudio();
    audioQueue.push(payload);
    playNext();
  }

  function append(role, text) {
    const div = document.createElement("div");
    div.className = "msg " + role;
    div.innerHTML = '<div class="role"></div><div class="body"></div>';
    div.querySelector(".role").textContent = role;
    div.querySelector(".body").textContent = text;
    logEl.appendChild(div);
    logEl.scrollTop = logEl.scrollHeight;
    return div;
  }

  function appendTurnSystem(text) {
    const div = document.createElement("div");
    div.className = "msg system";
    div.innerHTML = '<div class="role"></div><div class="body"></div>';
    div.querySelector(".role").textContent = "system";
    div.querySelector(".body").textContent = text;
    if (currentJarvisEl && currentJarvisEl.parentNode === logEl) {
      if (turnLastSystemEl && turnLastSystemEl.parentNode === logEl) {
        turnLastSystemEl.insertAdjacentElement("afterend", div);
      } else {
        logEl.insertBefore(div, currentJarvisEl);
      }
      turnLastSystemEl = div;
    } else {
      logEl.appendChild(div);
    }
    logEl.scrollTop = logEl.scrollHeight;
    return div;
  }

  function setStatus(text, cls) {
    statusEl.textContent = String(text).toUpperCase();
    statusEl.className = "status" + (cls ? " " + cls : "");
  }

  function setActivity(text) {
    if (!activityEl) return;
    activityEl.textContent = text || "ожидание";
  }

  function applyBrainMode(mode) {
    brainMode = mode === "local" ? "local" : "cursor";
    if (!btnBrain) return;
    btnBrain.textContent = brainMode === "local" ? "LOCAL" : "CURSOR";
    btnBrain.classList.toggle("local", brainMode === "local");
    btnBrain.title =
      brainMode === "local"
        ? "Сейчас локальный Qwen. Нажми → Cursor"
        : "Сейчас Cursor. Нажми → локальный Qwen";
  }

  function setStopVisible(on) {
    if (!btnStop) return;
    btnStop.classList.toggle("hidden", !on);
  }

  async function stopCurrentTask() {
    if (!api.stopTask) return;
    setActivity("останавливаю…");
    setStatus("stopping", "thinking");
    try {
      const msg = await api.stopTask();
      append("system", msg || "Остановил.");
      setStatus("online");
      setActivity("ожидание");
    } catch (e) {
      append("system", "Стоп: " + (e.message || e));
      setStatus("error", "error");
    } finally {
      busy = false;
      setStopVisible(false);
    }
  }

  async function submitText(text) {
    const t = String(text || "").trim();
    if (!t || busy) return;
    busy = true;
    setStopVisible(true);
    append("user", t);
    setStatus("thinking", "thinking");
    turnLastSystemEl = null;
    const live = append("jarvis", "…");
    currentJarvisEl = live;
    try {
      const answer = await api.askText(t);
      live.querySelector(".body").textContent = answer || "(empty)";
      if (String(answer || "").startsWith("Systems error:")) {
        setStatus("error", "error");
        setActivity("самолечение…");
      } else if (/^Остановил/i.test(String(answer || ""))) {
        setStatus("online");
        setActivity("остановлено");
      } else {
        setStatus("online");
      }
    } catch (e) {
      live.querySelector(".body").textContent = String(e);
      setStatus("error", "error");
      if (api.reportFault) {
        void api.reportFault({ source: "hud-ask", error: String(e), autoFix: true });
      }
    } finally {
      currentJarvisEl = null;
      turnLastSystemEl = null;
      busy = false;
      setStopVisible(false);
    }
  }

  function encodeWav(float32, sampleRate) {
    const numFrames = float32.length;
    const buffer = new ArrayBuffer(44 + numFrames * 2);
    const view = new DataView(buffer);
    const writeStr = (off, s) => {
      for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
    };
    writeStr(0, "RIFF");
    view.setUint32(4, 36 + numFrames * 2, true);
    writeStr(8, "WAVE");
    writeStr(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeStr(36, "data");
    view.setUint32(40, numFrames * 2, true);
    let off = 44;
    for (let i = 0; i < numFrames; i++) {
      let s = Math.max(-1, Math.min(1, float32[i]));
      view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      off += 2;
    }
    return buffer;
  }

  function downsampleTo16k(float32, fromRate) {
    if (fromRate === TARGET_RATE) return float32;
    const ratio = fromRate / TARGET_RATE;
    const newLen = Math.floor(float32.length / ratio);
    const out = new Float32Array(newLen);
    for (let i = 0; i < newLen; i++) {
      out[i] = float32[Math.floor(i * ratio)] || 0;
    }
    return out;
  }

  function peakAmplitude(float32) {
    let peak = 0;
    for (let i = 0; i < float32.length; i++) {
      const a = Math.abs(float32[i]);
      if (a > peak) peak = a;
    }
    return peak;
  }

  function bytesToBase64(buf) {
    const bytes = new Uint8Array(buf);
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  function mergePcmChunks(chunks) {
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const merged = new Float32Array(total);
    let o = 0;
    for (const c of chunks) {
      merged.set(c, o);
      o += c.length;
    }
    return merged;
  }

  function stopLiveStt() {
    if (liveSttTimer) {
      clearInterval(liveSttTimer);
      liveSttTimer = null;
    }
    liveSttBusy = false;
  }

  function clearLiveVoice() {
    stopLiveStt();
    if (liveVoiceEl) {
      liveVoiceEl.textContent = "";
      liveVoiceEl.classList.add("hidden");
      liveVoiceEl.classList.remove("interim");
    }
    input.placeholder = INPUT_PH;
  }

  function setLiveVoice(text, interim) {
    if (!liveVoiceEl) return;
    const t = String(text || "").trim();
    liveVoiceEl.textContent = t || "Слушаю…";
    liveVoiceEl.classList.remove("hidden");
    liveVoiceEl.classList.toggle("interim", !!interim && !!t);
    if (t) input.value = t;
    else input.value = "";
  }

  function sttText(result) {
    if (result == null) return "";
    if (typeof result === "string") return result.trim();
    return String(result.text || "").trim();
  }

  async function runLiveSttTick() {
    if (!recognizing || liveSttBusy || !pcmChunks.length || !api.transcribeWav) return;
    try {
      if (api.sttReady && !(await api.sttReady())) return; // don't spam while model loads
    } catch (_) {
      return;
    }
    const rate = window.__jarvisSampleRate || 48000;
    const merged = mergePcmChunks(pcmChunks);
    if (merged.length < rate * 0.55) return;
    const pcm16 = downsampleTo16k(merged, rate);
    if (peakAmplitude(pcm16) < LIVE_STT_MIN_PEAK) return;

    liveSttBusy = true;
    try {
      // Live preview: last ~4s only (faster + less Whisper thrash)
      const maxSamples = TARGET_RATE * 4;
      const slice = pcm16.length > maxSamples ? pcm16.subarray(pcm16.length - maxSamples) : pcm16;
      const wav = encodeWav(slice, TARGET_RATE);
      const b64 = bytesToBase64(wav);
      const text = sttText(await api.transcribeWav(b64));
      if (!recognizing || text.startsWith("STT_ERROR:")) return;
      if (text) {
        setLiveVoice(text, true);
        const short = text.length > 48 ? text.slice(0, 48) + "…" : text;
        setActivity("Слышу: " + short);
      }
    } catch (_) {
    } finally {
      liveSttBusy = false;
    }
  }

  function startLiveStt() {
    stopLiveStt();
    setLiveVoice("", true);
    setTimeout(() => void runLiveSttTick(), 700);
    liveSttTimer = setInterval(() => void runLiveSttTick(), LIVE_STT_MS);
  }

  function stopMicHardware() {
    stopLiveStt();
    if (listenTimer) {
      clearTimeout(listenTimer);
      listenTimer = null;
    }
    try {
      if (processor) {
        processor.disconnect();
        processor.onaudioprocess = null;
      }
    } catch (_) {}
    processor = null;
    try {
      if (audioCtx) audioCtx.close();
    } catch (_) {}
    audioCtx = null;
    if (mediaStream) {
      mediaStream.getTracks().forEach((t) => t.stop());
      mediaStream = null;
    }
  }

  async function finishListening() {
    if (!recognizing) return;
    recognizing = false;
    hud.classList.remove("listening");
    setStatus("transcribing", "thinking");
    setActivity("Распознаю речь (локально)…");
    if (liveVoiceEl) liveVoiceEl.classList.remove("interim");
    try {
      if (api.sttReady && !(await api.sttReady())) {
        setActivity("Качаю Whisper-модель (~50МБ, один раз)…");
        append("system", "Первый запуск голоса: скачиваю локальную модель Whisper. Дальше офлайн.");
      }
    } catch (_) {}

    const chunks = pcmChunks;
    pcmChunks = [];
    stopMicHardware();

    if (!chunks.length) {
      clearLiveVoice();
      setStatus("online");
      setActivity("ожидание");
      append("system", "Тишина — скажите ещё раз (🎤 / Ctrl+Shift+J).");
      return;
    }

    const merged = mergePcmChunks(chunks);
    // Input was already at audioCtx rate; we collected floats at ctx rate
    const rate = window.__jarvisSampleRate || 48000;
    const pcm16 = downsampleTo16k(merged, rate);
    const peak = peakAmplitude(pcm16);
    if (peak < 0.002) {
      clearLiveVoice();
      append(
        "system",
        "Захватил тишину — Chrome/Electron не развернул аудиоконтекст (часто после Ctrl+Shift+J). " +
          "Нажмите 🎤 в окне JARVIS, скажите фразу и снова 🎤 (или подождите 12 с)."
      );
      setStatus("online");
      setActivity("ожидание");
      return;
    }
    const wav = encodeWav(pcm16, TARGET_RATE);
    const b64 = bytesToBase64(wav);

    try {
      if (!api.transcribeWav) throw new Error("transcribeWav missing — rebuild JARVIS");
      const result = await api.transcribeWav(b64);
      const text = sttText(result);
      if (text.startsWith("STT_ERROR:")) {
        const err = text.slice("STT_ERROR:".length).trim();
        clearLiveVoice();
        append("system", err);
        setStatus("error", "error");
        setActivity("самолечение…");
        // Main already starts self-heal on STT throw; keep HUD in sync only
        return;
      }
      if (!text) {
        clearLiveVoice();
        const dur =
          result && typeof result === "object" && result.durationSec != null
            ? Number(result.durationSec).toFixed(1)
            : (pcm16.length / TARGET_RATE).toFixed(1);
        const p =
          result && typeof result === "object" && result.peak != null
            ? Number(result.peak).toFixed(3)
            : peak.toFixed(3);
        const rms =
          result && typeof result === "object" && result.rms != null
            ? Number(result.rms).toFixed(3)
            : "?";
        append(
          "system",
          `Не разобрал речь (${dur}s, peak=${p}, rms=${rms}). ` +
            `Говорите ближе к микрофону или напишите текстом. Лог: data/logs/jarvis.log`
        );
        setStatus("online");
        setActivity("ожидание");
        return;
      }
      setLiveVoice(text, false);
      input.value = text;
      clearLiveVoice();
      setStatus("online");
      setActivity("ожидание");
      await submitText(text);
    } catch (e) {
      append("system", String(e.message || e));
      setStatus("error", "error");
      setActivity("ожидание");
    }
  }

  async function startListening() {
    // Toggle: second press stops and transcribes (local STT — no Google)
    if (recognizing) {
      await finishListening();
      return;
    }
    if (busy) return;

    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: true,
        },
        video: false,
      });
    } catch (e) {
      append("system", "Нет доступа к микрофону: " + e.message);
      return;
    }

    input.value = "";
    pcmChunks = [];
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    window.__jarvisSampleRate = audioCtx.sampleRate;
    try {
      if (audioCtx.state === "suspended") await audioCtx.resume();
    } catch (e) {
      append("system", "Аудиоконтекст: " + e.message);
      stopMicHardware();
      return;
    }
    const source = audioCtx.createMediaStreamSource(mediaStream);
    processor = audioCtx.createScriptProcessor(4096, 1, 1);
    processor.onaudioprocess = (ev) => {
      const inputData = ev.inputBuffer.getChannelData(0);
      pcmChunks.push(new Float32Array(inputData));
    };
    const silent = audioCtx.createGain();
    silent.gain.value = 0;
    source.connect(processor);
    processor.connect(silent);
    silent.connect(audioCtx.destination);

    recognizing = true;
    hud.classList.add("listening");
    setStatus("listening");
    setActivity("Говорите… ещё раз 🎤 чтобы отправить");
    startLiveStt();
    listenTimer = setTimeout(() => {
      void finishListening();
    }, MAX_LISTEN_MS);
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const v = input.value;
    input.value = "";
    submitText(v);
  });

  btnMic.addEventListener("click", () => startListening());
  if (btnStop) btnStop.addEventListener("click", () => void stopCurrentTask());
  if (api.onStopTaskHotkey) api.onStopTaskHotkey(() => void stopCurrentTask());
  btnMute.addEventListener("click", async () => {
    muted = await api.setMute(!muted);
    btnMute.textContent = muted ? "🔇" : "🔊";
    if (muted) {
      stopAudio();
      if (api.stopTts) void api.stopTts();
    }
  });
  if (btnSilence) {
    btnSilence.addEventListener("click", () => {
      stopAudio();
      if (api.stopTts) void api.stopTts();
    });
  }
  if (btnBrain) {
    btnBrain.addEventListener("click", async () => {
      const next = brainMode === "local" ? "cursor" : "local";
      const mode = await api.setBrainMode(next);
      applyBrainMode(mode);
      append(
        "system",
        mode === "local"
          ? "Мозг: локальный Qwen (кнопка). Авто — только без сети / если Cursor упал."
          : "Мозг: Cursor (кнопка)."
      );
    });
  }

  document.getElementById("btnYes").addEventListener("click", () => {
    api.confirmResponse(true);
    confirmBox.classList.add("hidden");
  });
  document.getElementById("btnNo").addEventListener("click", () => {
    api.confirmResponse(false);
    confirmBox.classList.add("hidden");
  });

  api.onPtt(() => startListening());
  api.onBrainEvent((ev) => {
    if (ev.type === "status") {
      if (ev.status === "thinking") {
        setStatus("working", "thinking");
        if (ev.detail) setActivity(ev.detail);
      } else if (ev.status === "error") {
        setStatus("error", "error");
        setActivity(ev.detail || "ошибка");
      } else {
        setStatus(ev.detail || "online");
        setActivity("ожидание");
      }
    } else if (ev.type === "tool") {
      const line = String(ev.name || "Работаю…");
      setActivity(line);
      // Deduplicate spam: only log when the activity text changes
      if (line !== lastActivityKey) {
        lastActivityKey = line;
        if (currentJarvisEl) appendTurnSystem(line);
        else append("system", line);
      }
    }
  });
  api.onConfirmRequest((message) => {
    confirmText.textContent = message;
    confirmBox.classList.remove("hidden");
    setStatus("awaiting confirm", "thinking");
  });
  api.onConfirmResolved(() => confirmBox.classList.add("hidden"));
  api.onMuteChanged((m) => {
    muted = m;
    btnMute.textContent = muted ? "🔇" : "🔊";
    if (muted) stopAudio();
  });
  if (api.onPlayAudio) api.onPlayAudio((payload) => playAudio(payload));
  if (api.onStopAudio) api.onStopAudio((p) => stopAudio(p));
  if (api.onBrainModeChanged) api.onBrainModeChanged((m) => applyBrainMode(m));
  if (api.onReminder) {
    api.onReminder(({ text }) => {
      append("jarvis", text);
      setActivity("напоминание");
      void refreshRemindersHud();
    });
  }
  if (api.onRemindersChanged) api.onRemindersChanged(() => void refreshRemindersHud());
  if (api.onOpsChanged) api.onOpsChanged(() => void refreshOpsHud());

  api.getConfig().then((cfg) => {
    muted = cfg.muted;
    btnMute.textContent = muted ? "🔇" : "🔊";
    applyBrainMode(cfg.brainMode || "cursor");
    if (cfg.palette && cfg.palette.cyan) {
      document.documentElement.style.setProperty("--cyan", cfg.palette.cyan);
    }
    setStatus("online");
    append(
      "system",
      "JARVIS ready. CURSOR/LOCAL · STOP (Ctrl+Shift+X) · Ctrl+Shift+J = голос · Ctrl+Shift+H = HUD."
    );
    void refreshRemindersHud();
    void refreshOpsHud();
    setInterval(() => void refreshOpsHud(), 5000);
  }).catch((e) => {
    setStatus("error", "error");
    append("system", "Config error: " + e);
  });
})();
