import { supabase, displayDate, displayTime, displayDateTime, escapeHtml, setFeedback, safeError } from "./supabase.js";
import { fetchAllRows } from "./paginated-query.js";
import { adminErrorMessage } from "./admin-errors.js";
import { buildCheckInUrl, isLoopbackHost } from "./checkin-link.js";
import { findPossibleDuplicates } from "./duplicates.js";

const $ = (selector) => document.querySelector(selector);
const VIEWS = ["overview", "meetings", "attendance", "programs"];
const ROWS_PER_PAGE = 200;
const FULL_RELOAD_AFTER_MS = 5 * 60 * 1000;

const MEETING_COLUMNS =
  "id,title,meeting_date,start_time,notes,status,rotating_qr,attendance_token,attendance_opened_at,attendance_expires_at,attendance_closed_at,created_at";
const PROGRAM_COLUMNS = "id,name,is_active,created_at";
const ATTENDANCE_COLUMNS =
  "id,meeting_id,full_name,normalized_name,study_program_id,study_program_name,checked_in_at,source,recorded_by";

const state = {
  user: null,
  meetings: [],
  programs: [],
  attendance: [],
  counts: new Map(),
  duplicates: new Map(),
  view: "overview",
  editingMeetingId: null,
  confirmHandler: null,
  channel: null,
  realtimeLost: false,
  lastFullLoad: 0,
  attendanceLimit: ROWS_PER_PAGE,
  renderTimer: null,
};
// `generation` invalidates in-flight refreshes so only one polling chain ever runs.
const qr = { meetingId: null, instance: null, timer: null, failures: 0, generation: 0 };

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------
function localTodayISO() {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Makassar", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}
function formatMeetingDate(date, time) {
  const day = date ? displayDate(`${date}T12:00:00+08:00`) : "Tanggal belum diatur";
  return `${day}${time ? ` · ${String(time).slice(0, 5)} WITA` : ""}`;
}
function effectiveStatus(meeting) {
  if (meeting?.status !== "open") return meeting?.status;
  return meeting.attendance_expires_at && Date.parse(meeting.attendance_expires_at) > Date.now() ? "open" : "expired";
}
const STATUS_LABELS = { scheduled: "Terjadwal", open: "Presensi dibuka", closed: "Ditutup", expired: "Sesi berakhir" };
const statusLabel = (status) => STATUS_LABELS[status] || "Tidak diketahui";
const statusClass = (status) => (STATUS_LABELS[status] ? `status-${status}` : "");
const getMeeting = (id) => state.meetings.find((meeting) => meeting.id === id);
const programName = (entry) =>
  entry.study_program_name || state.programs.find((program) => program.id === entry.study_program_id)?.name || "Program tidak tersedia";
const errorText = (error) => adminErrorMessage(error, safeError(error));
const byMeetingOrder = (a, b) =>
  String(b.meeting_date).localeCompare(String(a.meeting_date)) || String(b.created_at).localeCompare(String(a.created_at));
const checkInTime = (entry) => Date.parse(entry.checked_in_at) || 0;
const byCheckIn = (a, b) => checkInTime(b) - checkInTime(a) || String(b.id).localeCompare(String(a.id));

/** Global status line, optionally with one action button (e.g. "Urungkan"). */
function showFeedback(message, type = "", action = null) {
  const element = $("#global-feedback");
  setFeedback(element, message, type);
  if (action && message) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "text-button feedback-action";
    button.textContent = action.label;
    button.addEventListener("click", () => {
      setFeedback(element, "");
      action.run();
    }, { once: true });
    element.append(" ", button);
  }
}

/** Replaces a <select>'s options only when they changed, so an open dropdown is not reset. */
function setOptions(select, options, preferred) {
  const signature = JSON.stringify(options);
  const previous = select.value;
  if (select.dataset.signature !== signature) {
    select.innerHTML = options.map(([value, label]) => `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`).join("");
    select.dataset.signature = signature;
  }
  const values = options.map(([value]) => value);
  if (values.includes(previous)) select.value = previous;
  else if (preferred && values.includes(preferred)) select.value = preferred;
}

// ---------------------------------------------------------------------------
// Data loading and live updates
// ---------------------------------------------------------------------------
const meetingsQuery = () =>
  supabase.from("meetings").select(MEETING_COLUMNS).order("meeting_date", { ascending: false }).order("created_at", { ascending: false }).order("id", { ascending: false });
const programsQuery = () => supabase.from("study_programs").select(PROGRAM_COLUMNS).order("name").order("id");
const attendanceQuery = () =>
  supabase.from("attendance").select(ATTENDANCE_COLUMNS).order("checked_in_at", { ascending: false }).order("id", { ascending: false });

async function loadData() {
  const [meetings, programs, attendance] = await Promise.all([
    fetchAllRows(meetingsQuery, 1000),
    fetchAllRows(programsQuery, 1000),
    fetchAllRows(attendanceQuery, 1000),
  ]);
  state.meetings = meetings;
  state.programs = programs;
  state.attendance = attendance.sort(byCheckIn);
  state.lastFullLoad = Date.now();
  renderAll();
}
async function reloadMeetings() {
  state.meetings = await fetchAllRows(meetingsQuery, 1000);
  scheduleRender();
}
async function reloadPrograms() {
  state.programs = await fetchAllRows(programsQuery, 1000);
  scheduleRender();
}
async function reloadAttendanceRow(id) {
  const { data, error } = await supabase.from("attendance").select(ATTENDANCE_COLUMNS).eq("id", id).maybeSingle();
  if (error) throw error;
  if (data) upsertLocal("attendance", data);
}

function upsertLocal(collection, row) {
  const list = state[collection];
  const index = list.findIndex((item) => item.id === row.id);
  if (index >= 0) list[index] = { ...list[index], ...row };
  else list.push(row);
  if (collection === "attendance") list.sort(byCheckIn);
  scheduleRender();
}
function removeLocal(collection, id) {
  state[collection] = state[collection].filter((item) => item.id !== id);
  scheduleRender();
}

function applyChange(collection, payload) {
  if (payload.eventType === "DELETE") {
    if (payload.old?.id) removeLocal(collection, payload.old.id);
  } else if (payload.new?.id) {
    upsertLocal(collection, payload.new);
  }
  if (collection === "meetings" && qr.meetingId && (payload.new?.id === qr.meetingId || payload.old?.id === qr.meetingId)) {
    refreshQr();
  }
}

function setupRealtime() {
  if (!supabase || !state.user || state.channel) return;
  state.channel = supabase
    .channel("gladius-admin-updates")
    .on("postgres_changes", { event: "*", schema: "public", table: "attendance" }, (payload) => applyChange("attendance", payload))
    .on("postgres_changes", { event: "*", schema: "public", table: "meetings" }, (payload) => applyChange("meetings", payload))
    .on("postgres_changes", { event: "*", schema: "public", table: "study_programs" }, (payload) => applyChange("programs", payload))
    .subscribe((status) => {
      if (status === "SUBSCRIBED" && state.realtimeLost) {
        // Events may have been missed while disconnected.
        state.realtimeLost = false;
        loadData()
          .then(() => showFeedback("Pembaruan langsung tersambung kembali. Data sudah dimuat ulang.", "success"))
          .catch((error) => showFeedback(errorText(error), "error"));
      }
      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        state.realtimeLost = true;
        showFeedback("Pembaruan langsung terputus. Dashboard akan memuat ulang data saat koneksi pulih.", "error");
      }
    });
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function scheduleRender() {
  window.clearTimeout(state.renderTimer);
  state.renderTimer = window.setTimeout(renderAll, 120);
}
function renderAll() {
  window.clearTimeout(state.renderTimer);
  state.counts = new Map();
  for (const entry of state.attendance) state.counts.set(entry.meeting_id, (state.counts.get(entry.meeting_id) || 0) + 1);
  state.duplicates = findPossibleDuplicates(state.attendance);
  renderOverview();
  renderMeetings();
  renderProgramList();
  populateSelects();
  renderAttendance();
}

function setView(view) {
  if (!VIEWS.includes(view)) return;
  state.view = view;
  document.querySelectorAll(".tab").forEach((tab) => {
    const active = tab.dataset.view === view;
    tab.classList.toggle("is-active", active);
    if (active) tab.setAttribute("aria-current", "page");
    else tab.removeAttribute("aria-current");
  });
  document.querySelectorAll(".view-section").forEach((section) => {
    const active = section.id === `view-${view}`;
    section.classList.toggle("is-active", active);
    section.hidden = !active;
  });
  if (view === "attendance") renderAttendance();
}

function renderOverview() {
  const sorted = [...state.meetings].sort(byMeetingOrder);
  const latestMeeting = sorted[0];
  const focusMeeting = sorted.find((meeting) => effectiveStatus(meeting) === "open") || latestMeeting;
  const focusCount = focusMeeting ? state.counts.get(focusMeeting.id) || 0 : 0;
  const stats = [
    { label: "Total rapat", value: state.meetings.length, note: "Seluruh rapat tersimpan" },
    { label: "Presensi sesi pilihan", value: focusMeeting ? focusCount : "—", note: focusMeeting ? focusMeeting.title : "Belum ada rapat" },
    { label: "Sesi aktif", value: state.meetings.filter((meeting) => effectiveStatus(meeting) === "open").length, note: "Presensi sedang dibuka" },
  ];
  $("#overview-stats").innerHTML = stats
    .map((stat) => `<article class="stat-card"><span class="stat-label">${escapeHtml(stat.label)}</span><strong class="stat-value">${escapeHtml(stat.value)}</strong><span class="stat-note">${escapeHtml(stat.note)}</span></article>`)
    .join("");

  // The placeholder styling (.empty-state) applies only while there is nothing to show.
  const setPanel = (selector, html, empty) => {
    const element = $(selector);
    element.className = empty ? "empty-state compact" : "panel-body";
    element.innerHTML = html;
  };
  if (!focusMeeting) {
    setPanel("#latest-meeting",  `<div class="empty-mark">＋</div><p>Belum ada rapat yang dibuat.</p><button class="text-button" type="button" data-go-view="meetings">Buat rapat pertama →</button>`, true);
  } else {
    const status = effectiveStatus(focusMeeting);
    const id = escapeHtml(focusMeeting.id);
    const action =
      status === "open"
        ? `<button class="button button-primary button-small" data-action="show-qr" data-id="${id}" type="button">Tampilkan QR</button>`
        : status === "scheduled"
          ? `<button class="button button-primary button-small" data-action="open" data-id="${id}" type="button">Buka presensi</button>`
          : "";
    setPanel("#latest-meeting", `
      <div class="latest-meeting">
        <div class="latest-main">
          <span class="status-pill ${statusClass(status)}">${statusLabel(status)}</span>
          <h4>${escapeHtml(focusMeeting.title)}</h4>
          <p>${escapeHtml(formatMeetingDate(focusMeeting.meeting_date, focusMeeting.start_time))}</p>
          <span class="muted">${focusCount} peserta tercatat</span>
        </div>
        <div class="latest-actions">${action}<button class="button button-secondary button-small" data-go-view="meetings" type="button">Kelola</button></div>
      </div>`, false);
  }

  const recent = state.attendance.slice(0, 5);
  setPanel("#recent-attendance", recent.length
    ? `<div class="recent-list">${recent
        .map(
          (entry) => `<div class="recent-row"><div class="avatar-dot">${escapeHtml((entry.full_name || "?").trim().charAt(0).toUpperCase())}</div><div class="recent-person"><strong>${escapeHtml(entry.full_name)}</strong><span>${escapeHtml(programName(entry))}</span></div><div class="recent-time">${escapeHtml(displayTime(entry.checked_in_at))}<small>WITA</small></div></div>`,
        )
        .join("")}</div>`
    : `<div class="empty-mark">↗</div><p>Belum ada peserta check-in.</p>`, !recent.length);

  const focusedEntries = focusMeeting ? state.attendance.filter((entry) => entry.meeting_id === focusMeeting.id) : [];
  $("#breakdown-caption").textContent = focusMeeting ? `Untuk: ${focusMeeting.title}` : "Distribusi akan muncul setelah presensi tercatat.";
  if (!focusedEntries.length) {
    setPanel("#program-breakdown", `<p>Belum ada data presensi untuk ditampilkan.</p>`, true);
    return;
  }
  const counts = new Map();
  focusedEntries.forEach((entry) => counts.set(programName(entry), (counts.get(programName(entry)) || 0) + 1));
  const max = Math.max(...counts.values());
  setPanel("#program-breakdown", `<div class="breakdown-list">${[...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `<div class="breakdown-row"><div class="breakdown-label"><span>${escapeHtml(name)}</span><strong>${count}</strong></div><div class="bar-track"><span style="width:${Math.round((count / max) * 100)}%"></span></div></div>`)
    .join("")}</div>`, false);
}

function meetingActions(meeting) {
  const status = effectiveStatus(meeting);
  const id = escapeHtml(meeting.id);
  const button = (action, label, style = "button-secondary") =>
    `<button class="button ${style} button-small" data-action="${action}" data-id="${id}" type="button">${label}</button>`;
  const textAction = (action, label, extra = "") => `<button class="icon-action ${extra}" data-action="${action}" data-id="${id}" type="button">${label}</button>`;
  const primary = {
    scheduled: button("open", "Buka presensi", "button-primary"),
    open: button("show-qr", "Tampilkan QR", "button-primary") + button("close", "Tutup presensi"),
    expired: button("extend", "Perpanjang sesi", "button-primary") + button("close", "Tutup sesi"),
    closed: button("reopen", "Buka ulang"),
  }[status] || "";
  const secondary = [
    status === "open" ? textAction("extend", "Perpanjang") : "",
    status === "open" ? textAction("regenerate", "Ganti QR") : "",
    textAction("edit", "Edit"),
    textAction("view-attendance", "Data presensi"),
    textAction("delete-meeting", "Hapus", "icon-action-danger"),
  ].join("");
  return `<div class="meeting-card-actions"><div class="action-row">${primary}</div><div class="action-row action-row-secondary">${secondary}</div></div>`;
}

function renderMeetings() {
  $("#meeting-count").textContent = `${state.meetings.length} rapat`;
  if (!state.meetings.length) {
    $("#meetings-list").innerHTML = `<div class="empty-state"><div class="empty-mark">＋</div><h3>Belum ada rapat</h3><p>Buat rapat pertama untuk menghasilkan QR presensi khusus.</p></div>`;
    return;
  }
  $("#meetings-list").innerHTML = [...state.meetings]
    .sort(byMeetingOrder)
    .map((meeting) => {
      const status = effectiveStatus(meeting);
      const meta = [
        `${state.counts.get(meeting.id) || 0} peserta hadir`,
        meeting.rotating_qr ? "QR berganti otomatis" : "Tautan tetap",
        meeting.attendance_opened_at ? `Dibuka ${displayTime(meeting.attendance_opened_at)} WITA` : "",
        status === "open" ? `Berakhir ${displayTime(meeting.attendance_expires_at)} WITA` : "",
        status === "expired" ? `Berakhir ${displayDateTime(meeting.attendance_expires_at)}` : "",
        meeting.attendance_closed_at && status === "closed" ? `Ditutup ${displayTime(meeting.attendance_closed_at)} WITA` : "",
      ].filter(Boolean);
      return `
        <article class="meeting-card">
          <div class="meeting-card-main">
            <div class="meeting-topline"><span class="status-pill ${statusClass(status)}">${statusLabel(status)}</span><span class="meeting-date">${escapeHtml(formatMeetingDate(meeting.meeting_date, meeting.start_time))}</span></div>
            <h3>${escapeHtml(meeting.title)}</h3>
            ${meeting.notes ? `<p class="meeting-note">${escapeHtml(meeting.notes)}</p>` : ""}
            <p class="meeting-meta">${meta.map((item) => `<span>${escapeHtml(item)}</span>`).join("")}</p>
          </div>
          ${meetingActions(meeting)}
        </article>`;
    })
    .join("");
}

function renderProgramList() {
  const programs = [...state.programs].sort((a, b) => a.name.localeCompare(b.name, "id"));
  if (!programs.length) {
    $("#programs-list").innerHTML = `<div class="empty-state compact"><div class="empty-mark">＋</div><p>Belum ada program studi. Tambahkan program studi agar tersedia di formulir presensi.</p></div>`;
    return;
  }
  $("#programs-list").innerHTML = programs
    .map(
      (program) => `<div class="program-row"><div><strong>${escapeHtml(program.name)}</strong><span class="program-state ${program.is_active ? "is-on" : "is-off"}">${program.is_active ? "Aktif" : "Nonaktif"}</span></div><button class="button button-secondary button-small" data-action="toggle-program" data-id="${escapeHtml(program.id)}" type="button">${program.is_active ? "Nonaktifkan" : "Aktifkan"}</button></div>`,
    )
    .join("");
}

function populateSelects() {
  const meetings = [...state.meetings].sort(byMeetingOrder);
  const meetingOptions = meetings.map((meeting) => [meeting.id, `${meeting.title} · ${formatMeetingDate(meeting.meeting_date)}`]);
  const programs = [...state.programs].sort((a, b) => a.name.localeCompare(b.name, "id"));

  setOptions($("#attendance-meeting-filter"), [["all", "Semua rapat"], ...meetingOptions]);
  setOptions($("#attendance-program-filter"), [["all", "Semua program studi"], ...programs.map((program) => [program.id, program.name])]);

  // Manual add: default to the filtered meeting, else the open session, else the latest meeting.
  const filtered = $("#attendance-meeting-filter").value;
  const preferredMeeting =
    (filtered !== "all" && filtered) || meetings.find((meeting) => effectiveStatus(meeting) === "open")?.id || meetings[0]?.id;
  setOptions($("#manual-meeting"), meetingOptions.length ? meetingOptions : [["", "Belum ada rapat"]], preferredMeeting);
  const activePrograms = programs.filter((program) => program.is_active);
  setOptions($("#manual-program"), [["", "Pilih program studi"], ...activePrograms.map((program) => [program.id, program.name])]);
  $("#manual-submit").disabled = !meetingOptions.length || !activePrograms.length;
}

function filteredAttendance() {
  const search = $("#attendance-search").value.trim().toLocaleLowerCase("id");
  const meetingId = $("#attendance-meeting-filter").value;
  const programId = $("#attendance-program-filter").value;
  const duplicatesOnly = $("#attendance-dup-filter").checked;
  return state.attendance.filter((entry) => {
    if (meetingId !== "all" && entry.meeting_id !== meetingId) return false;
    if (programId !== "all" && entry.study_program_id !== programId) return false;
    if (duplicatesOnly && !state.duplicates.has(entry.id)) return false;
    if (!search) return true;
    return `${entry.full_name} ${programName(entry)} ${getMeeting(entry.meeting_id)?.title || ""}`.toLocaleLowerCase("id").includes(search);
  });
}

function renderAttendance() {
  const rows = filteredAttendance();
  const visible = rows.slice(0, state.attendanceLimit);
  const duplicateCount = rows.filter((entry) => state.duplicates.has(entry.id)).length;
  $("#attendance-summary").textContent =
    `${rows.length} dari ${state.attendance.length} catatan presensi.` +
    (duplicateCount ? ` ${duplicateCount} perlu dicek (kemungkinan duplikat).` : "");
  $("#attendance-table-body").innerHTML = visible.length
    ? visible
        .map((entry) => {
          const meeting = getMeeting(entry.meeting_id);
          const duplicate = state.duplicates.get(entry.id);
          const badges = [
            entry.source === "manual" ? `<span class="tag">Manual</span>` : "",
            duplicate ? `<span class="tag tag-warning" title="${escapeHtml(duplicate)}">Cek duplikat</span>` : "",
          ].join("");
          return `<tr>
            <td data-label="Peserta"><strong>${escapeHtml(entry.full_name)}</strong>${badges ? `<span class="tag-row">${badges}</span>` : ""}${duplicate ? `<small>${escapeHtml(duplicate)}</small>` : ""}</td>
            <td data-label="Program studi">${escapeHtml(programName(entry))}</td>
            <td data-label="Rapat">${escapeHtml(meeting?.title || "Rapat tidak ditemukan")}<small>${escapeHtml(meeting ? formatMeetingDate(meeting.meeting_date) : "")}</small></td>
            <td data-label="Waktu check-in">${escapeHtml(displayDateTime(entry.checked_in_at))}</td>
            <td data-label="Aksi" class="cell-actions"><button class="icon-action icon-action-danger" data-action="delete-attendance" data-id="${escapeHtml(entry.id)}" type="button" aria-label="Hapus presensi ${escapeHtml(entry.full_name)}">Hapus</button></td>
          </tr>`;
        })
        .join("")
    : `<tr><td colspan="5" class="table-empty">${state.attendance.length ? "Tidak ada catatan yang sesuai dengan filter." : "Belum ada presensi tercatat."}</td></tr>`;
  const more = $("#attendance-more");
  const remaining = rows.length - visible.length;
  more.hidden = remaining <= 0;
  more.textContent = `Tampilkan ${Math.min(ROWS_PER_PAGE, remaining)} lagi (${remaining} tersisa)`;
}

function resetAttendancePaging() {
  state.attendanceLimit = ROWS_PER_PAGE;
  renderAttendance();
}

// ---------------------------------------------------------------------------
// Confirm dialog
// ---------------------------------------------------------------------------
function askConfirm({ title, message, label, danger = false, duration = false, onConfirm }) {
  $("#confirm-title").textContent = title;
  $("#confirm-message").textContent = message;
  $("#confirm-action").textContent = label;
  $("#confirm-action").classList.toggle("button-danger", danger);
  $("#confirm-action").classList.toggle("button-primary", !danger);
  $("#confirm-extra").hidden = !duration;
  if (duration) $("#confirm-duration").value = "180";
  state.confirmHandler = onConfirm;
  const dialog = $("#confirm-dialog");
  if (!dialog.open) dialog.showModal();
}

async function runConfirmed() {
  const handler = state.confirmHandler;
  state.confirmHandler = null;
  const duration = Number($("#confirm-duration").value) || 180;
  $("#confirm-dialog").close();
  if (!handler) return;
  try {
    await handler({ duration });
  } catch (error) {
    showFeedback(errorText(error), "error");
    if (/invalid_state_transition|meeting_not_found/.test(String(error?.message))) reloadMeetings().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Meetings
// ---------------------------------------------------------------------------
function resetMeetingForm() {
  state.editingMeetingId = null;
  $("#meeting-form").reset();
  $("#meeting-form-title").textContent = "Buat rapat baru";
  $("#meeting-save").textContent = "Simpan rapat";
  $("#meeting-cancel-edit").hidden = true;
  $("#meeting-rotating").checked = true;
  setFeedback($("#meeting-form-feedback"), "");
  $("#meeting-date").value = localTodayISO();
}

function editMeeting(meeting) {
  if (!meeting) return;
  state.editingMeetingId = meeting.id;
  $("#meeting-form-title").textContent = "Edit detail rapat";
  $("#meeting-save").textContent = "Simpan perubahan";
  $("#meeting-cancel-edit").hidden = false;
  $("#meeting-title").value = meeting.title;
  $("#meeting-date").value = meeting.meeting_date;
  $("#meeting-time").value = meeting.start_time ? String(meeting.start_time).slice(0, 5) : "";
  $("#meeting-notes").value = meeting.notes || "";
  $("#meeting-rotating").checked = meeting.rotating_qr !== false;
  $("#meeting-form").scrollIntoView({ behavior: "smooth", block: "start" });
  $("#meeting-title").focus({ preventScroll: true });
}

async function handleMeetingForm(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const payload = {
    title: form.elements.namedItem("title").value.trim(),
    meeting_date: form.elements.namedItem("meeting_date").value,
    start_time: form.elements.namedItem("start_time").value || null,
    notes: form.elements.namedItem("notes").value.trim() || null,
    rotating_qr: form.elements.namedItem("rotating_qr").checked,
  };
  if (payload.title.length < 3) {
    setFeedback($("#meeting-form-feedback"), "Nama rapat minimal 3 karakter.", "error");
    return;
  }
  if (!payload.meeting_date) {
    setFeedback($("#meeting-form-feedback"), "Tanggal rapat wajib diisi.", "error");
    return;
  }
  const save = $("#meeting-save");
  const editingId = state.editingMeetingId;
  save.disabled = true;
  save.textContent = "Menyimpan…";
  setFeedback($("#meeting-form-feedback"), "");
  try {
    const { error } = editingId
      ? await supabase.rpc("admin_update_meeting", {
          p_meeting_id: editingId,
          p_title: payload.title,
          p_meeting_date: payload.meeting_date,
          p_start_time: payload.start_time,
          p_notes: payload.notes,
          p_rotating_qr: payload.rotating_qr,
        })
      : await supabase.from("meetings").insert({ ...payload, status: "scheduled", created_by: state.user.id });
    if (error) throw error;
    resetMeetingForm();
    await reloadMeetings();
    showFeedback(editingId ? "Perubahan rapat disimpan." : "Rapat berhasil dibuat.", "success");
  } catch (error) {
    setFeedback($("#meeting-form-feedback"), errorText(error), "error");
  } finally {
    save.disabled = false;
    save.textContent = state.editingMeetingId ? "Simpan perubahan" : "Simpan rapat";
  }
}

function openSession(meeting, reopen = false) {
  askConfirm({
    title: reopen ? "Buka ulang presensi?" : "Buka presensi?",
    message: reopen
      ? `Sesi “${meeting.title}” akan dibuka kembali dengan QR baru. Presensi yang sudah tercatat tetap tersimpan.`
      : `Sesi presensi untuk “${meeting.title}” akan dibuka dan QR khusus dibuat untuk rapat ini.`,
    label: reopen ? "Buka ulang" : "Buka presensi",
    duration: true,
    onConfirm: async ({ duration }) => {
      const { error } = await supabase.rpc("admin_set_meeting_status", { p_meeting_id: meeting.id, p_new_status: "open", p_duration_minutes: duration });
      if (error) throw error;
      await reloadMeetings();
      showFeedback("Presensi dibuka. QR sesi sudah tersedia.", "success");
      await showQr(getMeeting(meeting.id));
    },
  });
}

function closeSession(meeting) {
  askConfirm({
    title: "Tutup presensi?",
    message: `Sesi “${meeting.title}” akan ditutup. Peserta tidak dapat check-in lagi, tetapi admin masih bisa menambah presensi manual atau membuka ulang sesi.`,
    label: "Tutup presensi",
    danger: true,
    onConfirm: async () => {
      const { error } = await supabase.rpc("admin_set_meeting_status", { p_meeting_id: meeting.id, p_new_status: "closed" });
      if (error) throw error;
      if (qr.meetingId === meeting.id) $("#qr-dialog").close();
      await reloadMeetings();
      showFeedback("Presensi ditutup.", "success");
    },
  });
}

function extendSession(meeting) {
  askConfirm({
    title: "Perpanjang sesi?",
    message: `Sesi “${meeting.title}” akan tetap terbuka selama durasi yang dipilih, dihitung mulai sekarang. QR yang sedang tampil tetap berlaku.`,
    label: "Perpanjang",
    duration: true,
    onConfirm: async ({ duration }) => {
      const { error } = await supabase.rpc("admin_extend_session", { p_meeting_id: meeting.id, p_duration_minutes: duration });
      if (error) throw error;
      await reloadMeetings();
      showFeedback("Sesi diperpanjang.", "success");
    },
  });
}

function regenerateQr(meeting) {
  askConfirm({
    title: "Ganti QR sesi ini?",
    message: "Semua QR, tautan, dan formulir dari QR lama langsung tidak berlaku. Peserta yang sedang mengisi formulir perlu scan ulang. Gunakan ini jika QR atau tautan tersebar ke luar ruangan.",
    label: "Ganti QR",
    danger: true,
    onConfirm: async () => {
      const { error } = await supabase.rpc("admin_regenerate_qr", { p_meeting_id: meeting.id });
      if (error) throw error;
      await reloadMeetings();
      showFeedback("QR baru dibuat. QR dan tautan lama tidak berlaku lagi.", "success");
      if (qr.meetingId === meeting.id) refreshQr();
    },
  });
}

function deleteMeeting(meeting) {
  const count = state.counts.get(meeting.id) || 0;
  askConfirm({
    title: "Hapus rapat?",
    message: count
      ? `Rapat “${meeting.title}” beserta ${count} catatan presensinya akan dihapus dari dashboard. Catatan presensi disimpan di arsip database dan hanya dapat dipulihkan melalui Supabase SQL Editor.`
      : `Rapat “${meeting.title}” akan dihapus.`,
    label: "Hapus rapat",
    danger: true,
    onConfirm: async () => {
      const { error } = await supabase.rpc("admin_delete_meeting", { p_meeting_id: meeting.id });
      if (error) throw error;
      if (qr.meetingId === meeting.id) $("#qr-dialog").close();
      if (state.editingMeetingId === meeting.id) resetMeetingForm();
      state.attendance = state.attendance.filter((entry) => entry.meeting_id !== meeting.id);
      removeLocal("meetings", meeting.id);
      showFeedback(`Rapat “${meeting.title}” dihapus.`, "success");
    },
  });
}

// ---------------------------------------------------------------------------
// QR dialog (rotating codes come from the database clock every 15 s)
// ---------------------------------------------------------------------------
function stopQr() {
  qr.generation += 1;
  window.clearTimeout(qr.timer);
  qr.meetingId = null;
  qr.instance = null;
  qr.failures = 0;
  $("#qr-dialog").classList.remove("is-presenting");
  $("#qr-fullscreen").textContent = "Tampilkan layar penuh";
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}

async function showQr(meeting) {
  if (!meeting || effectiveStatus(meeting) !== "open") {
    showFeedback("QR hanya tersedia untuk sesi presensi yang sedang dibuka.", "error");
    return;
  }
  stopQr();
  qr.meetingId = meeting.id;
  $("#qr-meeting-name").textContent = `${meeting.title} · ${formatMeetingDate(meeting.meeting_date, meeting.start_time)}`;
  $("#qr-code").replaceChildren();
  $("#qr-timer").hidden = true;
  $("#qr-session-info").textContent = "";
  setFeedback($("#qr-feedback"), "");
  const dialog = $("#qr-dialog");
  if (!dialog.open) dialog.showModal();
  if (typeof window.QRCode === "undefined") {
    $("#qr-code").textContent = "Pustaka QR belum berhasil dimuat. Muat ulang halaman.";
    return;
  }
  qr.instance = new window.QRCode($("#qr-code"), {
    width: 512,
    height: 512,
    colorDark: "#0b1424",
    colorLight: "#ffffff",
    correctLevel: window.QRCode.CorrectLevel.M,
  });
  await refreshQr();
}

function animateTimer(ms) {
  const bar = $("#qr-timer-bar");
  bar.style.transition = "none";
  bar.style.transform = "scaleX(1)";
  void bar.offsetWidth; // restart the transition
  bar.style.transition = `transform ${ms}ms linear`;
  bar.style.transform = "scaleX(0)";
}

async function refreshQr() {
  const meetingId = qr.meetingId;
  if (!meetingId || !qr.instance) return;
  window.clearTimeout(qr.timer);
  const generation = ++qr.generation;
  const isCurrent = () => qr.generation === generation && qr.meetingId === meetingId && qr.instance;
  let data;
  try {
    const result = await supabase.rpc("admin_get_qr_code", { p_meeting_id: meetingId });
    if (result.error) throw result.error;
    data = result.data;
  } catch (error) {
    if (!isCurrent()) return;
    if (/session_not_open|meeting_not_found/.test(String(error?.message))) {
      $("#qr-code").replaceChildren(Object.assign(document.createElement("p"), { className: "qr-closed", textContent: "Sesi ini tidak lagi dibuka. Peserta tidak dapat check-in." }));
      qr.instance = null;
      $("#qr-timer").hidden = true;
      return;
    }
    qr.failures += 1;
    setFeedback(
      $("#qr-feedback"),
      qr.failures >= 2 ? "QR belum dapat diperbarui. Periksa koneksi laptop; QR yang tampil hanya berlaku ±90 detik." : "Memperbarui QR…",
      qr.failures >= 2 ? "error" : "",
    );
    qr.timer = window.setTimeout(refreshQr, 3000);
    return;
  }
  if (!isCurrent()) return;
  qr.failures = 0;
  setFeedback($("#qr-feedback"), "");

  const params = data.rotating ? { m: meetingId, c: data.code } : { token: data.token };
  const link = buildCheckInUrl(params, window.location.href, window.GLADIUS_CONFIG?.checkInBaseUrl);
  qr.instance.makeCode(link.href);
  $("#qr-code").removeAttribute("title");
  $("#qr-link").value = link.href;
  $("#qr-link-block").hidden = data.rotating;
  $("#qr-timer").hidden = !data.rotating;
  $("#qr-instruction").textContent = data.rotating
    ? "Scan dengan kamera ponsel. QR berganti setiap 15 detik; foto atau tautan yang diteruskan berhenti berlaku dalam ±90 detik."
    : "Tautan tetap: QR dan tautan ini dapat dibagikan selama sesi dibuka.";
  $("#qr-session-info").textContent = data.expires_at ? `Sesi berakhir ${displayDateTime(data.expires_at)}` : "";
  if (isLoopbackHost(link.hostname)) {
    setFeedback(
      $("#qr-feedback"),
      "Peringatan: tautan QR memakai localhost, sehingga tidak bisa dibuka dari HP. Buka dashboard melalui alamat jaringan (contoh http://192.168.1.41:3000/admin.html) atau atur checkInBaseUrl di js/config.js.",
      "error",
    );
  }
  if (data.rotating) {
    animateTimer(data.refresh_in_ms);
    qr.timer = window.setTimeout(refreshQr, data.refresh_in_ms + 150);
  } else {
    // Static links do not change; re-check occasionally so a closed session is shown.
    qr.timer = window.setTimeout(refreshQr, 60_000);
  }
}

async function togglePresenting() {
  const dialog = $("#qr-dialog");
  if (dialog.classList.contains("is-presenting")) {
    dialog.classList.remove("is-presenting");
    $("#qr-fullscreen").textContent = "Tampilkan layar penuh";
    if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
    return;
  }
  dialog.classList.add("is-presenting");
  $("#qr-fullscreen").textContent = "Keluar layar penuh";
  try {
    await dialog.requestFullscreen?.();
  } catch {
    // The enlarged dialog still fills the window without the Fullscreen API.
  }
}

// ---------------------------------------------------------------------------
// Attendance: delete / undo / manual add / export
// ---------------------------------------------------------------------------
function deleteAttendance(entry) {
  const meeting = getMeeting(entry.meeting_id);
  askConfirm({
    title: "Hapus presensi?",
    message: `Catatan “${entry.full_name}” (${programName(entry)}) pada rapat “${meeting?.title || "-"}” akan dihapus. Kamu dapat mengurungkannya segera setelah ini.`,
    label: "Hapus",
    danger: true,
    onConfirm: async () => {
      const { data, error } = await supabase.rpc("admin_delete_attendance", { p_attendance_id: entry.id });
      if (error) throw error;
      removeLocal("attendance", entry.id);
      showFeedback(`Presensi “${entry.full_name}” dihapus.`, "success", {
        label: "Urungkan",
        run: () => restoreAttendance(data.archive_id, entry.full_name),
      });
    },
  });
}

async function restoreAttendance(archiveId, name) {
  try {
    const { data, error } = await supabase.rpc("admin_restore_attendance", { p_archive_id: archiveId });
    if (error) throw error;
    await reloadAttendanceRow(data.id);
    showFeedback(`Presensi “${name}” dipulihkan.`, "success");
  } catch (error) {
    showFeedback(errorText(error), "error");
  }
}

async function handleManualForm(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const feedback = $("#manual-feedback");
  const meetingId = form.elements.namedItem("meeting_id").value;
  const fullName = form.elements.namedItem("full_name").value.trim().replace(/\s+/g, " ");
  const programId = form.elements.namedItem("study_program_id").value;
  if (!meetingId) return setFeedback(feedback, "Pilih rapat terlebih dahulu.", "error");
  if (fullName.length < 2) return setFeedback(feedback, "Nama minimal 2 karakter.", "error");
  if (!programId) return setFeedback(feedback, "Pilih program studi.", "error");
  const button = $("#manual-submit");
  button.disabled = true;
  setFeedback(feedback, "Menyimpan…");
  try {
    const { data, error } = await supabase.rpc("admin_add_attendance", { p_meeting_id: meetingId, p_full_name: fullName, p_study_program_id: programId });
    if (error) throw error;
    await reloadAttendanceRow(data.id);
    form.elements.namedItem("full_name").value = "";
    form.elements.namedItem("full_name").focus();
    setFeedback(feedback, `“${fullName}” ditambahkan ke ${getMeeting(meetingId)?.title || "rapat"}.`, "success");
  } catch (error) {
    setFeedback(feedback, errorText(error), "error");
  } finally {
    button.disabled = false;
  }
}

function exportCsv() {
  const rows = filteredAttendance();
  if (!rows.length) {
    showFeedback("Tidak ada data untuk diekspor dengan filter saat ini.", "error");
    return;
  }
  const headings = ["Judul rapat", "Tanggal rapat", "Nama peserta", "Program studi", "Status kehadiran", "Sumber", "Waktu check-in (Asia/Makassar, UTC+08:00)"];
  const csvCell = (value) => {
    const raw = String(value ?? "");
    // Prevent spreadsheet formula execution from untrusted participant/program names.
    const safeValue = /^[\s]*[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
    return `"${safeValue.replace(/"/g, '""')}"`;
  };
  const lines = [
    headings,
    ...rows.map((entry) => {
      const meeting = getMeeting(entry.meeting_id);
      const checkedInWita = entry.checked_in_at
        ? new Date(checkInTime(entry) + 8 * 60 * 60 * 1000).toISOString().replace("Z", "+08:00")
        : "";
      return [
        meeting?.title || "Rapat tidak ditemukan",
        meeting?.meeting_date || "",
        entry.full_name,
        programName(entry),
        "Hadir",
        entry.source === "manual" ? "Manual (admin)" : "QR",
        checkedInWita,
      ];
    }),
  ]
    .map((row) => row.map(csvCell).join(","))
    .join("\r\n");
  const blob = new Blob(["﻿", lines], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `gladius-presensi-${localTodayISO()}.csv`;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  showFeedback(`${rows.length} catatan diekspor ke CSV. Timestamp menggunakan ISO 8601 dengan offset WITA (+08:00).`, "success");
}

// ---------------------------------------------------------------------------
// Programs
// ---------------------------------------------------------------------------
async function toggleProgram(program) {
  try {
    const { error } = await supabase.from("study_programs").update({ is_active: !program.is_active }).eq("id", program.id);
    if (error) throw error;
    await reloadPrograms();
    showFeedback(`Program studi ${program.is_active ? "dinonaktifkan" : "diaktifkan"}.`, "success");
  } catch (error) {
    showFeedback(errorText(error), "error");
  }
}

async function handleProgramForm(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const name = form.elements.namedItem("name").value.trim().replace(/\s+/g, " ");
  const feedback = $("#program-form-feedback");
  if (name.length < 2) {
    setFeedback(feedback, "Nama program studi minimal 2 karakter.", "error");
    return;
  }
  const button = form.querySelector("button[type=submit]");
  button.disabled = true;
  try {
    const { error } = await supabase.from("study_programs").insert({ name, is_active: true });
    if (error) {
      if (error.code === "23505") {
        setFeedback(feedback, "Program studi dengan nama tersebut sudah ada.", "error");
        return;
      }
      throw error;
    }
    form.reset();
    await reloadPrograms();
    setFeedback(feedback, "Program studi ditambahkan.", "success");
  } catch (error) {
    setFeedback(feedback, errorText(error), "error");
  } finally {
    button.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Startup and event wiring
// ---------------------------------------------------------------------------
async function verifyAdmin() {
  const { data: { session }, error } = await supabase.auth.getSession();
  if (error || !session) {
    location.replace("login.html");
    return false;
  }
  const { data: profile, error: profileError } = await supabase.from("profiles").select("role").eq("id", session.user.id).maybeSingle();
  if (profileError || profile?.role !== "admin") {
    await supabase.auth.signOut();
    location.replace("login.html");
    return false;
  }
  state.user = session.user;
  $("#admin-email").textContent = session.user.email || "Administrator";
  return true;
}

async function init() {
  if (!supabase) {
    document.querySelectorAll("button, input, select, textarea").forEach((control) => {
      control.disabled = true;
    });
    showFeedback("Aplikasi belum dikonfigurasi. Isi URL dan publishable key Supabase di js/config.js sesuai docs/DEPLOY.md.", "error");
    return;
  }
  $("#today-label").textContent = new Intl.DateTimeFormat("id-ID", { weekday: "short", day: "numeric", month: "short", timeZone: "Asia/Makassar" }).format(new Date());
  if (!(await verifyAdmin())) return;
  await loadData();
  resetMeetingForm();
  setupRealtime();
  // Status labels depend on the clock (open → expired); refresh them periodically.
  window.setInterval(() => {
    if (document.visibilityState === "visible") scheduleRender();
  }, 30_000);
}

$("#logout-button").addEventListener("click", async () => {
  if (state.channel) await supabase.removeChannel(state.channel);
  await supabase.auth.signOut();
  location.replace("login.html");
});
document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => setView(button.dataset.view)));
document.addEventListener("click", (event) => {
  const go = event.target.closest("[data-go-view]");
  if (go) setView(go.dataset.goView);
  const close = event.target.closest("[data-close-dialog]");
  if (close) $(`#${close.dataset.closeDialog}`).close();
  const actionButton = event.target.closest("[data-action]");
  if (!actionButton) return;
  const { action, id } = actionButton.dataset;
  const meeting = getMeeting(id);
  switch (action) {
    case "show-qr":
      showQr(meeting);
      break;
    case "open":
      if (meeting) openSession(meeting);
      break;
    case "reopen":
      if (meeting) openSession(meeting, true);
      break;
    case "close":
      if (meeting) closeSession(meeting);
      break;
    case "extend":
      if (meeting) extendSession(meeting);
      break;
    case "regenerate":
      if (meeting) regenerateQr(meeting);
      break;
    case "delete-meeting":
      if (meeting) deleteMeeting(meeting);
      break;
    case "edit":
      setView("meetings");
      editMeeting(meeting);
      break;
    case "view-attendance":
      setView("attendance");
      $("#attendance-meeting-filter").value = id;
      resetAttendancePaging();
      populateSelects();
      break;
    case "delete-attendance": {
      const entry = state.attendance.find((item) => item.id === id);
      if (entry) deleteAttendance(entry);
      break;
    }
    case "toggle-program": {
      const program = state.programs.find((item) => item.id === id);
      if (program) toggleProgram(program);
      break;
    }
    default:
      break;
  }
});
$("#meeting-form").addEventListener("submit", handleMeetingForm);
$("#meeting-cancel-edit").addEventListener("click", resetMeetingForm);
$("#manual-form").addEventListener("submit", handleManualForm);
$("#program-form").addEventListener("submit", handleProgramForm);
$("#attendance-search").addEventListener("input", resetAttendancePaging);
$("#attendance-meeting-filter").addEventListener("change", () => {
  resetAttendancePaging();
  populateSelects();
});
$("#attendance-program-filter").addEventListener("change", resetAttendancePaging);
$("#attendance-dup-filter").addEventListener("change", resetAttendancePaging);
$("#attendance-more").addEventListener("click", () => {
  state.attendanceLimit += ROWS_PER_PAGE;
  renderAttendance();
});
$("#export-csv").addEventListener("click", exportCsv);
$("#confirm-action").addEventListener("click", runConfirmed);
$("#confirm-dialog").addEventListener("close", () => {
  state.confirmHandler = null;
});
$("#qr-dialog").addEventListener("close", stopQr);
// Background tabs throttle timers; refresh the QR as soon as the tab is visible again.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && qr.meetingId) refreshQr();
});
$("#qr-fullscreen").addEventListener("click", togglePresenting);
document.addEventListener("fullscreenchange", () => {
  if (!document.fullscreenElement && $("#qr-dialog").classList.contains("is-presenting")) {
    $("#qr-dialog").classList.remove("is-presenting");
    $("#qr-fullscreen").textContent = "Tampilkan layar penuh";
  }
});
$("#copy-qr-link").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("#qr-link").value);
    setFeedback($("#qr-feedback"), "Tautan berhasil disalin.", "success");
  } catch {
    $("#qr-link").select();
    setFeedback($("#qr-feedback"), "Salin tautan secara manual menggunakan menu perangkat.", "error");
  }
});

if (supabase) {
  supabase.auth.onAuthStateChange((event) => {
    if (event === "SIGNED_OUT") location.replace("login.html");
  });
  // Realtime keeps data current; fall back to a full reload after long inactivity.
  window.addEventListener("focus", () => {
    if (state.user && (state.realtimeLost || Date.now() - state.lastFullLoad > FULL_RELOAD_AFTER_MS)) {
      loadData().catch((error) => showFeedback(errorText(error), "error"));
    }
  });
}
init().catch((error) => showFeedback(errorText(error), "error"));
