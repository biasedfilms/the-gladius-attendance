import { beginFailureMessage, checkInFailureMessage, functionCodeMessage } from "./check-in-errors.js";
import { parseCheckInParams } from "./checkin-link.js";
import { supabase, displayDate, displayDateTime, displayTime, escapeHtml, setFeedback, safeError } from "./supabase.js";

const $ = (selector) => document.querySelector(selector);
const root = $("#checkin-content");
const link = parseCheckInParams(location.search);
let session = null; // { id, title, meeting_date, start_time, status, ticket, ticket_expires_at }
let submitting = false;

// ---------------------------------------------------------------------------
// Browser storage (best effort: private mode or blocked storage must not break check-in)
// ---------------------------------------------------------------------------
const store = {
  get(area, key) {
    try {
      const raw = window[area].getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  },
  set(area, key, value) {
    try {
      window[area].setItem(key, JSON.stringify(value));
    } catch {
      /* ignore */
    }
  },
};
// The ticket for this exact link survives a page reload (the QR code itself expires after ~90 s).
const ticketKey = `gladius-ticket:${location.search}`;
const lastParticipantKey = "gladius-last-participant";
const deviceRecordKey = (meetingId) => `gladius-checked-in:${meetingId}`;

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function meetingSummary(meeting) {
  if (!meeting?.title) return "";
  const time = meeting.start_time ? ` · ${escapeHtml(String(meeting.start_time).slice(0, 5))} WITA` : "";
  return `<div class="meeting-summary"><span class="summary-label">RAPAT</span><strong>${escapeHtml(meeting.title)}</strong><span>${escapeHtml(displayDate(`${meeting.meeting_date}T12:00:00+08:00`))}${time}</span></div>`;
}

function renderState(title, message, { kind = "warning", meeting = null, home = true } = {}) {
  root.innerHTML = `
    <p class="eyebrow">PRESENSI RAPAT</p>
    <div class="state-icon ${kind === "success" ? "state-icon-success" : "state-icon-warning"}" aria-hidden="true">${kind === "success" ? "✓" : "!"}</div>
    <h1>${escapeHtml(title)}</h1>
    <p class="muted state-description">${escapeHtml(message)}</p>
    ${meetingSummary(meeting)}
    ${home ? `<a class="button button-secondary button-full" href="index.html">Kembali ke beranda</a>` : ""}`;
}

async function loadSession() {
  if (!supabase) {
    renderState("Aplikasi belum dikonfigurasi.", "Administrator perlu mengisi URL dan publishable key Supabase di js/config.js sebelum presensi dapat digunakan.");
    return;
  }
  if (!link) {
    renderState(
      "Tautan presensi tidak valid.",
      "Alamat yang dibuka tidak memuat kode QR yang diperlukan. Scan QR yang ditampilkan di layar rapat; jangan mengetik alamat check-in.html secara manual.",
    );
    return;
  }

  const saved = store.get("sessionStorage", ticketKey);
  if (saved?.ticket && Date.parse(saved.ticket_expires_at) - Date.now() > 30_000) {
    session = saved;
    renderForm();
    return;
  }

  if (!navigator.onLine) {
    renderState("Koneksi internet diperlukan.", "Sambungkan perangkat ke internet agar sesi dapat divalidasi. Presensi belum dicatat.");
    return;
  }

  const args = link.kind === "rotating" ? { p_meeting_id: link.meetingId, p_code: link.code } : { p_token: link.token };
  const { data, error } = await supabase.rpc("begin_checkin", args);
  if (error) throw error;
  if (!data?.valid) {
    const [title, message] = beginFailureMessage(data?.reason);
    renderState(title, message, { meeting: data?.title ? data : null });
    return;
  }
  if (data.status !== "open") {
    const messages = {
      closed: ["Presensi sudah ditutup.", "Sesi ini telah ditutup oleh administrator. Kehadiran baru tidak dapat dicatat."],
      expired: ["Sesi presensi sudah berakhir.", "Masa berlaku sesi sudah habis. Minta administrator memperpanjang sesi."],
      scheduled: ["Presensi belum dibuka.", "Administrator belum membuka sesi presensi untuk rapat ini."],
    };
    const [title, message] = messages[data.status] || messages.scheduled;
    renderState(title, message, { meeting: data });
    return;
  }
  session = data;
  store.set("sessionStorage", ticketKey, data);
  renderForm();
}

async function renderForm() {
  const previous = store.get("localStorage", deviceRecordKey(session.id));
  const deviceNote = previous?.full_name
    ? `<p class="device-note" role="note">Perangkat ini sudah mencatat kehadiran atas nama <strong>${escapeHtml(previous.full_name)}</strong>${previous.checked_in_at ? ` pukul ${escapeHtml(displayTime(previous.checked_in_at))} WITA` : ""}. Jika kamu orang lain yang meminjam perangkat ini, lanjutkan mengisi formulir.</p>`
    : "";
  root.innerHTML = `
    <p class="eyebrow">PRESENSI RAPAT</p>
    <span class="status-pill status-open">Presensi dibuka</span>
    <h1>Catat kehadiran.</h1>
    <p class="muted">Isi nama dan program studi dengan benar. Proses ini hanya memerlukan beberapa detik.</p>
    ${meetingSummary(session)}
    ${deviceNote}
    <form id="checkin-form" class="form-stack checkin-form" novalidate>
      <label for="participant-name">Nama lengkap <span class="required">*</span></label>
      <input id="participant-name" name="full_name" autocomplete="name" maxlength="100" minlength="2" placeholder="Masukkan nama lengkap" required>
      <label for="participant-program">Program studi <span class="required">*</span></label>
      <select id="participant-program" name="study_program_id" required><option value="">Memuat program studi…</option></select>
      <p class="form-hint">Tulis nama lengkap yang sama setiap rapat. Presensi dengan nama dan program studi yang sama akan dikenali sebagai duplikat.</p>
      <button id="checkin-submit" class="button button-primary button-full" type="submit" disabled>Kirim presensi</button>
      <p id="checkin-feedback" class="feedback" role="status" aria-live="polite"></p>
    </form>`;

  const form = $("#checkin-form");
  const select = $("#participant-program");
  form.addEventListener("submit", submitAttendance);

  const { data: programs, error } = await supabase.rpc("get_active_study_programs");
  if (error) {
    select.innerHTML = `<option value="">Program studi tidak dapat dimuat</option>`;
    setFeedback($("#checkin-feedback"), "Daftar program studi gagal dimuat. Muat ulang halaman setelah koneksi stabil.", "error");
    return;
  }
  if (!programs?.length) {
    select.innerHTML = `<option value="">Belum ada program studi tersedia</option>`;
    select.disabled = true;
    setFeedback($("#checkin-feedback"), "Administrator belum menambahkan program studi. Hubungi pengelola rapat.", "error");
    return;
  }
  select.innerHTML =
    `<option value="">Pilih program studi</option>` +
    programs.map((program) => `<option value="${escapeHtml(program.id)}">${escapeHtml(program.name)}</option>`).join("");

  // Weekly meetings: pre-fill what this device used last time (editable).
  const last = store.get("localStorage", lastParticipantKey);
  if (last?.full_name && !previous) form.full_name.value = last.full_name;
  if (last?.study_program_id && programs.some((program) => program.id === last.study_program_id) && !previous) {
    select.value = last.study_program_id;
  }
  $("#checkin-submit").disabled = false;
}

async function submitAttendance(event) {
  event.preventDefault();
  if (submitting) return;
  const form = event.currentTarget;
  const feedback = $("#checkin-feedback");
  if (!navigator.onLine) {
    setFeedback(feedback, "Koneksi internet terputus. Presensi belum dikirim.", "error");
    return;
  }
  const fullName = form.full_name.value.trim().replace(/\s+/g, " ");
  const programId = form.study_program_id.value;
  if (fullName.length < 2 || fullName.length > 100) {
    setFeedback(feedback, "Nama harus terdiri dari 2–100 karakter.", "error");
    form.full_name.focus();
    return;
  }
  if (!programId) {
    setFeedback(feedback, "Pilih program studi terlebih dahulu.", "error");
    form.study_program_id.focus();
    return;
  }
  const programName = form.study_program_id.selectedOptions[0]?.textContent || "";

  submitting = true;
  const button = $("#checkin-submit");
  button.disabled = true;
  button.textContent = "Mengirim presensi…";
  setFeedback(feedback, "Memvalidasi sesi dan menyimpan kehadiran…");
  try {
    const { data, error } = await supabase.functions.invoke(window.GLADIUS_CONFIG.checkInFunction || "check-in", {
      body: { ticket: session.ticket, full_name: fullName, study_program_id: programId },
    });
    if (error) throw error;
    if (data?.ok || data?.code === "already_recorded") {
      const record = { full_name: fullName, study_program_id: programId, checked_in_at: data.checked_in_at || new Date().toISOString() };
      store.set("localStorage", lastParticipantKey, { full_name: fullName, study_program_id: programId });
      store.set("localStorage", deviceRecordKey(session.id), record);
      try {
        sessionStorage.removeItem(ticketKey);
      } catch {
        /* ignore */
      }
      renderSuccess({ ...data, full_name: fullName, program_name: programName });
      return;
    }
    if (["session_invalid", "ticket_expired", "session_closed", "session_expired", "session_not_open", "rate_limited"].includes(data?.code)) {
      try {
        sessionStorage.removeItem(ticketKey);
      } catch {
        /* ignore */
      }
      renderState("Presensi belum berhasil.", functionCodeMessage(data.code), { meeting: session });
      return;
    }
    // Fixable input problems keep the form so the participant can correct it.
    setFeedback(feedback, functionCodeMessage(data?.code) || "Server belum dapat mencatat presensi. Periksa data lalu coba kembali.", "error");
    button.disabled = false;
    button.textContent = "Kirim presensi";
  } catch (error) {
    setFeedback(feedback, await checkInFailureMessage(error), "error");
    button.disabled = false;
    button.textContent = "Coba kirim lagi";
  } finally {
    submitting = false;
  }
}

function renderSuccess(result) {
  const already = result.code === "already_recorded";
  const timestampRow =
    !already && result.checked_in_at
      ? `<div><span>Waktu diproses server</span><strong>${escapeHtml(displayDateTime(result.checked_in_at))}</strong></div>`
      : "";
  const note = already
    ? "Tidak ada catatan baru yang dibuat. Jika kamu merasa data ini bukan milikmu, hubungi administrator."
    : "Waktu di atas menunjukkan waktu pemrosesan check-in oleh server, bukan verifikasi independen waktu kedatangan fisik.";
  root.innerHTML = `
    <p class="eyebrow">PRESENSI RAPAT</p>
    <div class="state-icon state-icon-success" aria-hidden="true">✓</div>
    <h1>${already ? "Kehadiran sudah tercatat." : "Kehadiran tercatat."}</h1>
    <p class="muted state-description">${already ? "Presensi dengan nama dan program studi ini sudah ada untuk sesi tersebut." : "Terima kasih. Data kehadiran berhasil disimpan oleh server."}</p>
    <div class="success-details">
      <div><span>Nama peserta</span><strong>${escapeHtml(result.full_name || "")}</strong></div>
      <div><span>Program studi</span><strong>${escapeHtml(result.program_name || "")}</strong></div>
      <div><span>Rapat</span><strong>${escapeHtml(session?.title || "")}</strong></div>
      <div><span>Tanggal rapat</span><strong>${escapeHtml(displayDate(`${session?.meeting_date}T12:00:00+08:00`))}</strong></div>
      ${timestampRow}
    </div>
    <p class="form-hint">${escapeHtml(note)}</p>`;
}

loadSession().catch((error) => {
  console.error("[Gladius check-in] Session could not be loaded", { message: error?.message, code: error?.code });
  renderState("Sesi belum dapat dimuat.", safeError(error));
});
