import { checkInFailureMessage, functionCodeMessage } from "./check-in-errors.js";
import {
  supabase,
  displayDate,
  displayDateTime,
  escapeHtml,
  setFeedback,
  safeError,
} from "./supabase.js";

const $ = (selector) => document.querySelector(selector);
const token = new URLSearchParams(location.search).get("token") || "";
const root = $("#checkin-content");
let sessionInfo = null;
let submitting = false;

function renderError(title, message, options = {}) {
  root.innerHTML = `<p class="eyebrow">PRESENSI RAPAT</p><div class="state-icon ${options.kind === "success" ? "state-icon-success" : "state-icon-warning"}" aria-hidden="true">${options.kind === "success" ? "✓" : "!"}</div><h1>${escapeHtml(title)}</h1><p class="muted state-description">${escapeHtml(message)}</p>${options.meeting ? `<div class="meeting-summary"><strong>${escapeHtml(options.meeting.title)}</strong><span>${escapeHtml(displayDate(`${options.meeting.meeting_date}T12:00:00+08:00`))}</span></div>` : ""}${options.link ? `<a class="button button-secondary button-full" href="index.html">Kembali ke beranda</a>` : ""}`;
}
async function loadSession() {
  if (!supabase) {
    renderError(
      "Aplikasi belum dikonfigurasi.",
      "Administrator perlu mengisi URL dan publishable key Supabase di js/config.js sebelum presensi dapat digunakan.",
      { link: true },
    );
    return;
  }
  if (!navigator.onLine) {
    renderError(
      "Koneksi internet diperlukan.",
      "Sambungkan perangkat ke internet agar sesi dapat divalidasi. Presensi belum dicatat.",
      { link: true },
    );
    return;
  }
  if (!token || token.length > 160) {
    renderError(
      "Tautan presensi tidak valid.",
      "Alamat yang dibuka tidak memuat token QR yang diperlukan. Scan QR yang ditampilkan dari dashboard admin, dan jangan hanya membuka alamat IP atau mengetik check-in.html tanpa parameter token.",
      { link: true },
    );
    return;
  }
  const { data, error } = await supabase.rpc("get_checkin_session", {
    p_token: token,
  });
  if (error) throw error;
  if (!data?.valid) {
    renderError(
      "Sesi tidak ditemukan.",
      "QR ini tidak valid atau tidak lagi tersedia. Minta administrator menampilkan QR sesi yang benar.",
      { link: true },
    );
    return;
  }
  sessionInfo = data;
  if (data.status !== "open") {
    const stateMessages = {
      closed: [
        "Presensi sudah ditutup.",
        "Sesi ini telah ditutup oleh administrator. Kehadiran baru tidak dapat dicatat.",
      ],
      expired: [
        "QR presensi sudah kedaluwarsa.",
        "Masa berlaku QR sudah habis. Minta administrator membuka sesi yang masih berlaku.",
      ],
      scheduled: [
        "Presensi belum dibuka.",
        "Administrator belum membuka sesi presensi untuk rapat ini.",
      ],
    };
    const [title, message] =
      stateMessages[data.status] || stateMessages.scheduled;
    renderError(title, message, { meeting: data, link: true });
    return;
  }
  renderForm(data);
}
async function renderForm(meeting) {
  root.innerHTML = `<p class="eyebrow">PRESENSI RAPAT</p><span class="status-pill status-open">Presensi dibuka</span><h1>Catat kehadiran.</h1><p class="muted">Isi nama dan program studi dengan benar. Proses ini hanya memerlukan beberapa detik.</p><div class="meeting-summary"><span class="summary-label">RAPAT</span><strong>${escapeHtml(meeting.title)}</strong><span>${escapeHtml(displayDate(`${meeting.meeting_date}T12:00:00+08:00`))}${meeting.start_time ? ` · ${escapeHtml(String(meeting.start_time).slice(0, 5))} WITA` : ""}</span></div><form id="checkin-form" class="form-stack checkin-form"><label for="participant-name">Nama lengkap <span class="required">*</span></label><input id="participant-name" name="full_name" autocomplete="name" maxlength="100" minlength="2" placeholder="Masukkan nama lengkap" required><label for="participant-program">Program studi <span class="required">*</span></label><select id="participant-program" name="study_program_id" required><option value="">Memuat program studi…</option></select><p class="form-hint">Periksa ejaan nama sebelum mengirim. Presensi dengan nama dan program studi yang sama akan dikenali sebagai duplikat.</p><button id="checkin-submit" class="button button-primary button-full" type="submit">Kirim presensi</button><p id="checkin-feedback" class="feedback" role="status" aria-live="polite"></p></form>`;
  const select = $("#participant-program");
  const { data: programs, error } = await supabase.rpc(
    "get_active_study_programs",
  );
  if (error) {
    select.innerHTML = `<option value="">Program studi tidak dapat dimuat</option>`;
    setFeedback(
      $("#checkin-feedback"),
      "Daftar program studi gagal dimuat. Muat ulang halaman setelah koneksi stabil.",
      "error",
    );
    return;
  }
  select.innerHTML =
    `<option value="">Pilih program studi</option>` +
    (programs || [])
      .map(
        (program) =>
          `<option value="${escapeHtml(program.id)}">${escapeHtml(program.name)}</option>`,
      )
      .join("");
  if (!(programs || []).length) {
    select.innerHTML = `<option value="">Belum ada program studi tersedia</option>`;
    select.disabled = true;
    $("#checkin-submit").disabled = true;
    setFeedback(
      $("#checkin-feedback"),
      "Administrator belum menambahkan program studi. Hubungi pengelola rapat.",
      "error",
    );
  }
  $("#checkin-form").addEventListener("submit", submitAttendance);
}
async function submitAttendance(event) {
  event.preventDefault();
  if (submitting) return;
  if (!navigator.onLine) {
    setFeedback(
      $("#checkin-feedback"),
      "Koneksi internet terputus. Presensi belum dikirim.",
      "error",
    );
    return;
  }
  const form = event.currentTarget;
  const fullName = form.full_name.value.trim().replace(/\s+/g, " ");
  const programId = form.study_program_id.value;
  if (fullName.length < 2 || fullName.length > 100) {
    setFeedback(
      $("#checkin-feedback"),
      "Nama harus terdiri dari 2–100 karakter.",
      "error",
    );
    return;
  }
  if (!programId) {
    setFeedback(
      $("#checkin-feedback"),
      "Pilih program studi terlebih dahulu.",
      "error",
    );
    return;
  }
  submitting = true;
  const button = $("#checkin-submit");
  button.disabled = true;
  button.textContent = "Mengirim presensi…";
  setFeedback(
    $("#checkin-feedback"),
    "Memvalidasi sesi dan menyimpan kehadiran…",
  );
  try {
    const { data, error } = await supabase.functions.invoke(
      window.GLADIUS_CONFIG.checkInFunction || "check-in",
      { body: { token, full_name: fullName, study_program_id: programId } },
    );
    if (error) throw error;
    if (!data?.ok) {
      const programName =
        $("#participant-program").selectedOptions[0]?.textContent || "";
      if (data?.code === "already_recorded") {
        renderSuccess({
          ...data,
          full_name: fullName,
          program_name: programName,
          meeting: sessionInfo,
        });
        return;
      }
      const messages = {
        session_invalid:
          "QR tidak valid. Minta administrator menampilkan QR yang benar.",
        session_closed:
          "Presensi telah ditutup. Kehadiran baru tidak dapat dicatat.",
        session_expired:
          "QR presensi sudah kedaluwarsa. Minta administrator menampilkan sesi yang masih berlaku.",
        session_not_open: "Presensi belum dibuka oleh administrator.",
        invalid_name: "Nama tidak valid. Periksa kembali nama yang dimasukkan.",
        invalid_program: "Program studi tidak valid atau sudah tidak aktif.",
        rate_limited:
          "Terlalu banyak percobaan dari perangkat ini. Tunggu beberapa menit lalu coba kembali.",
      };
      renderError(
        "Presensi belum berhasil.",
        messages[data?.code] ||
          functionCodeMessage(data?.code) ||
          "Server belum dapat mencatat presensi. Periksa data dan coba kembali.",
        { kind: "warning", meeting: sessionInfo },
      );
      return;
    }
    const programName =
      $("#participant-program").selectedOptions[0]?.textContent || "";
    renderSuccess({
      ...data,
      full_name: fullName,
      program_name: programName,
      meeting: sessionInfo,
    });
  } catch (error) {
    const message = await checkInFailureMessage(error);
    setFeedback(
      $("#checkin-feedback"),
      `${message} Presensi belum dianggap tercatat.`,
      "error",
    );
    button.disabled = false;
    button.textContent = "Coba kirim lagi";
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
  root.innerHTML = `<p class="eyebrow">PRESENSI RAPAT</p><div class="state-icon state-icon-success" aria-hidden="true">✓</div><h1>${already ? "Kehadiran sudah tercatat." : "Kehadiran tercatat."}</h1><p class="muted state-description">${already ? "Presensi dengan nama dan program studi ini sudah ada untuk sesi tersebut." : "Terima kasih. Data kehadiran berhasil disimpan oleh server."}</p><div class="success-details"><div><span>Nama peserta</span><strong>${escapeHtml(result.full_name || "")}</strong></div><div><span>Program studi</span><strong>${escapeHtml(result.program_name || "")}</strong></div><div><span>Rapat</span><strong>${escapeHtml(result.meeting?.title || "")}</strong></div><div><span>Tanggal rapat</span><strong>${escapeHtml(displayDate(`${result.meeting?.meeting_date}T12:00:00+08:00`))}</strong></div>${timestampRow}</div><p class="form-hint">${escapeHtml(note)}</p>`;
}
loadSession().catch((error) => {
  renderError("Sesi belum dapat dimuat.", safeError(error), { link: true });
});
