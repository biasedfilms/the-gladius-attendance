import { supabase, displayDate, displayTime, displayDateTime, escapeHtml, setFeedback, safeError } from "./supabase.js";

const $ = (selector) => document.querySelector(selector);
const state = { user: null, meetings: [], programs: [], attendance: [], selectedView: "overview", editingMeetingId: null, confirmHandler: null, channel: null };
let refreshTimeout = null;
const views = ["overview", "meetings", "attendance", "programs"];

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
  return meeting?.status === "open" && meeting.attendance_expires_at && new Date(meeting.attendance_expires_at).getTime() <= Date.now() ? "expired" : meeting?.status;
}
function statusLabel(status) { return ({ scheduled: "Terjadwal", open: "Presensi dibuka", closed: "Ditutup", expired: "Kedaluwarsa" })[status] || "Tidak diketahui"; }
function statusClass(status) { return ({ scheduled: "status-scheduled", open: "status-open", closed: "status-closed", expired: "status-expired" })[status] || ""; }
function getMeeting(id) { return state.meetings.find((meeting) => meeting.id === id); }
function getProgramName(id) { return state.programs.find((program) => program.id === id)?.name || "Program tidak aktif / tidak tersedia"; }
function showFeedback(message, type = "") { setFeedback($("#global-feedback"), message, type); }
function setView(view) {
  if (!views.includes(view)) return;
  state.selectedView = view;
  document.querySelectorAll(".tab").forEach((tab) => { const active = tab.dataset.view === view; tab.classList.toggle("is-active", active); if (active) tab.setAttribute("aria-current", "page"); else tab.removeAttribute("aria-current"); });
  document.querySelectorAll(".view-section").forEach((section) => { const active = section.id === `view-${view}`; section.classList.toggle("is-active", active); section.hidden = !active; });
  if (view === "attendance") renderAttendance();
}
function askConfirm(title, message, label, callback, danger = false) {
  $("#confirm-title").textContent = title; $("#confirm-message").textContent = message; $("#confirm-action").textContent = label;
  $("#confirm-action").classList.toggle("button-danger", danger); state.confirmHandler = callback;
  const dialog = $("#confirm-dialog"); if (!dialog.open) dialog.showModal();
}

async function verifyAdmin() {
  const { data: { session }, error } = await supabase.auth.getSession();
  if (error || !session) { location.replace("login.html"); return false; }
  const { data: profile, error: profileError } = await supabase.from("profiles").select("role").eq("id", session.user.id).maybeSingle();
  if (profileError || profile?.role !== "admin") { await supabase.auth.signOut(); location.replace("login.html"); return false; }
  state.user = session.user; $("#admin-email").textContent = session.user.email || "Administrator";
  return true;
}
async function loadData() {
  const [meetingResult, programResult, attendanceResult] = await Promise.all([
    supabase.from("meetings").select("id,title,meeting_date,start_time,notes,status,attendance_token,attendance_opened_at,attendance_expires_at,attendance_closed_at,created_at").order("meeting_date", { ascending: false }).order("created_at", { ascending: false }),
    supabase.from("study_programs").select("id,name,is_active,created_at").order("name"),
    supabase.from("attendance").select("id,meeting_id,full_name,normalized_name,study_program_id,study_program_name,checked_in_at").order("checked_in_at", { ascending: false })
  ]);
  const error = meetingResult.error || programResult.error || attendanceResult.error;
  if (error) throw error;
  state.meetings = meetingResult.data || []; state.programs = programResult.data || []; state.attendance = attendanceResult.data || [];
  renderAll();
}
function renderAll() { renderOverview(); renderMeetings(); renderProgramList(); populateFilters(); renderAttendance(); }
function renderOverview() {
  const latestMeeting = [...state.meetings].sort((a,b) => String(b.meeting_date).localeCompare(String(a.meeting_date)) || String(b.created_at).localeCompare(String(a.created_at)))[0];
  const focusMeeting = state.meetings.find((m) => effectiveStatus(m) === "open") || latestMeeting;
  const visibleCount = focusMeeting ? state.attendance.filter((entry) => entry.meeting_id === focusMeeting.id).length : 0;
  const stats = [
    { label: "Total rapat", value: state.meetings.length, note: "Seluruh rapat tersimpan" },
    { label: "Presensi sesi pilihan", value: focusMeeting ? visibleCount : "—", note: focusMeeting ? focusMeeting.title : "Belum ada rapat" },
    { label: "Sesi aktif", value: state.meetings.filter((meeting) => effectiveStatus(meeting) === "open").length, note: "Presensi sedang dibuka" }
  ];
  $("#overview-stats").innerHTML = stats.map((stat) => `<article class="stat-card"><span class="stat-label">${escapeHtml(stat.label)}</span><strong class="stat-value">${escapeHtml(stat.value)}</strong><span class="stat-note">${escapeHtml(stat.note)}</span></article>`).join("");
  if (!latestMeeting) {
    $("#latest-meeting").innerHTML = `<div class="empty-mark">＋</div><p>Belum ada rapat yang dibuat.</p><button class="text-button" type="button" data-go-view="meetings">Buat rapat pertama →</button>`;
  } else {
    $("#latest-meeting").innerHTML = `<div class="latest-meeting"><div class="latest-main"><span class="status-pill ${statusClass(effectiveStatus(latestMeeting))}">${statusLabel(effectiveStatus(latestMeeting))}</span><h4>${escapeHtml(latestMeeting.title)}</h4><p>${escapeHtml(formatMeetingDate(latestMeeting.meeting_date, latestMeeting.start_time))}</p><span class="muted">${state.attendance.filter((entry) => entry.meeting_id === latestMeeting.id).length} peserta tercatat</span></div><div class="latest-actions">${effectiveStatus(latestMeeting) === "open" ? `<button class="button button-primary button-small" data-action="show-qr" data-id="${latestMeeting.id}" type="button">Tampilkan QR</button>` : ""}<button class="button button-secondary button-small" data-go-view="meetings" type="button">Kelola</button></div></div>`;
  }
  const recent = state.attendance.slice(0, 5);
  $("#recent-attendance").innerHTML = recent.length ? `<div class="recent-list">${recent.map((entry) => { const meeting = getMeeting(entry.meeting_id); return `<div class="recent-row"><div class="avatar-dot">${escapeHtml((entry.full_name || "?").trim().charAt(0).toUpperCase())}</div><div class="recent-person"><strong>${escapeHtml(entry.full_name)}</strong><span>${escapeHtml(entry.study_program_name || getProgramName(entry.study_program_id))}</span></div><div class="recent-time">${escapeHtml(displayTime(entry.checked_in_at))}<small>WITA</small></div></div>`; }).join("")}</div>` : `<div class="empty-state compact"><div class="empty-mark">↗</div><p>Belum ada peserta check-in.</p></div>`;
  const focusedEntries = focusMeeting ? state.attendance.filter((entry) => entry.meeting_id === focusMeeting.id) : [];
  $("#breakdown-caption").textContent = focusMeeting ? `Untuk: ${focusMeeting.title}` : "Distribusi akan muncul setelah presensi tercatat.";
  if (!focusedEntries.length) { $("#program-breakdown").innerHTML = `<p>Belum ada data presensi untuk ditampilkan.</p>`; return; }
  const counts = new Map(); focusedEntries.forEach((entry) => { const name = entry.study_program_name || getProgramName(entry.study_program_id); counts.set(name, (counts.get(name) || 0) + 1); });
  const max = Math.max(...counts.values());
  $("#program-breakdown").innerHTML = `<div class="breakdown-list">${[...counts.entries()].sort((a,b) => b[1]-a[1]).map(([name,count]) => `<div class="breakdown-row"><div class="breakdown-label"><span>${escapeHtml(name)}</span><strong>${count}</strong></div><div class="bar-track"><span style="width:${Math.round(count/max*100)}%"></span></div></div>`).join("")}</div>`;
}
function renderMeetings() {
  $("#meeting-count").textContent = `${state.meetings.length} rapat`;
  if (!state.meetings.length) { $("#meetings-list").innerHTML = `<div class="empty-state"><div class="empty-mark">＋</div><h3>Belum ada rapat</h3><p>Buat rapat pertama untuk menghasilkan QR presensi khusus.</p></div>`; return; }
  const sorted = [...state.meetings].sort((a,b) => String(b.meeting_date).localeCompare(String(a.meeting_date)) || String(b.created_at).localeCompare(String(a.created_at)));
  $("#meetings-list").innerHTML = sorted.map((meeting) => {
    const count = state.attendance.filter((entry) => entry.meeting_id === meeting.id).length;
    const currentStatus = effectiveStatus(meeting);
    const statusAction = currentStatus === "scheduled" ? `<button class="button button-primary button-small" data-action="open" data-id="${meeting.id}" type="button">Buka presensi</button>` : currentStatus === "open" ? `<button class="button button-secondary button-small" data-action="close" data-id="${meeting.id}" type="button">Tutup presensi</button><button class="button button-secondary button-small" data-action="show-qr" data-id="${meeting.id}" type="button">Tampilkan QR</button>` : currentStatus === "expired" ? `<button class="button button-secondary button-small" data-action="close" data-id="${meeting.id}" type="button">Tutup sesi kedaluwarsa</button>` : `<span class="muted small-note">Sesi sudah ditutup</span>`;
    const canEdit = meeting.status !== "closed";
    return `<article class="meeting-card"><div class="meeting-card-main"><div class="meeting-topline"><span class="status-pill ${statusClass(currentStatus)}">${statusLabel(currentStatus)}</span><span class="meeting-date">${escapeHtml(formatMeetingDate(meeting.meeting_date, meeting.start_time))}</span></div><h3>${escapeHtml(meeting.title)}</h3>${meeting.notes ? `<p class="meeting-note">${escapeHtml(meeting.notes)}</p>` : ""}<p class="meeting-meta"><span>${count} peserta hadir</span>${meeting.attendance_opened_at ? `<span>Dibuka ${escapeHtml(displayTime(meeting.attendance_opened_at))} WITA</span>` : ""}${meeting.attendance_closed_at ? `<span>Ditutup ${escapeHtml(displayTime(meeting.attendance_closed_at))} WITA</span>` : ""}</p></div><div class="meeting-card-actions">${statusAction}${canEdit ? `<button class="icon-action" data-action="edit" data-id="${meeting.id}" type="button" aria-label="Edit ${escapeHtml(meeting.title)}">Edit</button>` : ""}<button class="icon-action" data-action="view-attendance" data-id="${meeting.id}" type="button">Data presensi</button></div></article>`;
  }).join("");
}
function renderProgramList() {
  const programs = [...state.programs].sort((a,b) => a.name.localeCompare(b.name, "id"));
  if (!programs.length) { $("#programs-list").innerHTML = `<div class="empty-state compact"><div class="empty-mark">＋</div><p>Belum ada program studi. Tambahkan program studi agar tersedia di formulir presensi.</p></div>`; return; }
  $("#programs-list").innerHTML = programs.map((program) => `<div class="program-row"><div><strong>${escapeHtml(program.name)}</strong><span class="program-state ${program.is_active ? "is-on" : "is-off"}">${program.is_active ? "Aktif" : "Nonaktif"}</span></div><button class="button button-secondary button-small" data-action="toggle-program" data-id="${program.id}" type="button">${program.is_active ? "Nonaktifkan" : "Aktifkan"}</button></div>`).join("");
}
function populateFilters() {
  const meetingFilter = $("#attendance-meeting-filter"); const oldMeeting = meetingFilter.value || "all";
  meetingFilter.innerHTML = `<option value="all">Semua rapat</option>` + state.meetings.map((meeting) => `<option value="${meeting.id}">${escapeHtml(meeting.title)} · ${escapeHtml(meeting.meeting_date)}</option>`).join("");
  if ([...meetingFilter.options].some((option) => option.value === oldMeeting)) meetingFilter.value = oldMeeting;
  const programFilter = $("#attendance-program-filter"); const oldProgram = programFilter.value || "all";
  programFilter.innerHTML = `<option value="all">Semua program studi</option>` + state.programs.map((program) => `<option value="${program.id}">${escapeHtml(program.name)}</option>`).join("");
  if ([...programFilter.options].some((option) => option.value === oldProgram)) programFilter.value = oldProgram;
}
function filteredAttendance() {
  const search = $("#attendance-search").value.trim().toLocaleLowerCase("id"); const meetingId = $("#attendance-meeting-filter").value; const programId = $("#attendance-program-filter").value;
  return state.attendance.filter((entry) => {
    const meeting = getMeeting(entry.meeting_id); const programName = entry.study_program_name || getProgramName(entry.study_program_id);
    return (!search || `${entry.full_name} ${programName} ${meeting?.title || ""}`.toLocaleLowerCase("id").includes(search)) && (meetingId === "all" || entry.meeting_id === meetingId) && (programId === "all" || entry.study_program_id === programId);
  });
}
function renderAttendance() {
  if (!$("#attendance-table-body")) return;
  const rows = filteredAttendance(); $("#attendance-summary").textContent = `${rows.length} catatan presensi${rows.length === 1 ? "" : ""} ditampilkan dari ${state.attendance.length} catatan.`;
  $("#attendance-table-body").innerHTML = rows.length ? rows.map((entry) => { const meeting = getMeeting(entry.meeting_id); return `<tr><td data-label="Peserta"><strong>${escapeHtml(entry.full_name)}</strong></td><td data-label="Program studi">${escapeHtml(entry.study_program_name || getProgramName(entry.study_program_id))}</td><td data-label="Rapat">${escapeHtml(meeting?.title || "Rapat tidak ditemukan")}<small>${escapeHtml(meeting?.meeting_date || "")}</small></td><td data-label="Waktu check-in">${escapeHtml(displayDateTime(entry.checked_in_at))}</td></tr>`; }).join("") : `<tr><td colspan="4" class="table-empty">Tidak ada catatan yang sesuai dengan filter.</td></tr>`;
}
function resetMeetingForm() {
  state.editingMeetingId = null; $("#meeting-form").reset(); $("#meeting-form-title").textContent = "Buat rapat baru"; $("#meeting-save").textContent = "Simpan rapat"; $("#meeting-cancel-edit").hidden = true; setFeedback($("#meeting-form-feedback"), "");
  $("#meeting-date").value = localTodayISO();
}
function buildCheckInUrl(token) {
  const configuredBase = String(window.GLADIUS_CONFIG?.checkInBaseUrl || "").trim();
  let link;
  if (configuredBase) {
    link = new URL(configuredBase, window.location.href);
    // Accept either a full check-in.html URL or an origin/directory as the override.
    if (!/check-in\.html$/i.test(link.pathname)) {
      link = new URL("check-in.html", link.href.endsWith("/") ? link.href : `${link.href}/`);
    }
  } else {
    link = new URL("check-in.html", window.location.href);
  }
  link.search = "";
  link.hash = "";
  link.searchParams.set("token", token);
  return link;
}

function isLoopbackHost(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "::1" || host === "0.0.0.0" || /^127(?:\.\d{1,3}){3}$/.test(host);
}

async function showQr(meeting) {
  if (!meeting || effectiveStatus(meeting) !== "open" || !meeting.attendance_token) { showFeedback("QR hanya tersedia untuk sesi presensi yang sedang dibuka.", "error"); return; }
  const link = buildCheckInUrl(meeting.attendance_token);
  $("#qr-meeting-name").textContent = `${meeting.title} · ${formatMeetingDate(meeting.meeting_date, meeting.start_time)}`;
  $("#qr-link").value = link.href; $("#qr-code").replaceChildren(); setFeedback($("#qr-feedback"), "");
  const dialog = $("#qr-dialog"); if (!dialog.open) dialog.showModal();

  // A QR containing localhost/127.0.0.1 points to the phone itself, not the Mac.
  if (isLoopbackHost(link.hostname)) {
    setFeedback($("#qr-feedback"), "Peringatan: tautan QR ini menggunakan localhost. HP tidak bisa mengakses localhost milik Mac. Buka dashboard admin melalui alamat Network dari npx serve (contoh http://192.168.1.41:3000/admin.html), atau atur checkInBaseUrl di js/config.js.", "error");
  } else if (!link.searchParams.get("token") || link.searchParams.get("token").length > 160) {
    setFeedback($("#qr-feedback"), "Token QR tidak valid. Tutup dialog dan buka ulang sesi presensi.", "error");
    $("#qr-code").textContent = "QR tidak dibuat karena token tidak valid.";
    return;
  }

  if (typeof window.QRCode === "undefined") { $("#qr-code").textContent = "Pustaka QR belum berhasil dimuat. Salin tautan check-in sebagai alternatif."; return; }
  new window.QRCode($("#qr-code"), { text: link.href, width: 240, height: 240, colorDark: "#191820", colorLight: "#ffffff", correctLevel: window.QRCode.CorrectLevel.M });
}
async function handleMeetingForm(event) {
  event.preventDefault(); const form = event.currentTarget;
  const payload = { title: form.elements.namedItem("title").value.trim(), meeting_date: form.elements.namedItem("meeting_date").value, start_time: form.elements.namedItem("start_time").value || null, notes: form.elements.namedItem("notes").value.trim() || null };
  if (payload.title.length < 3) { setFeedback($("#meeting-form-feedback"), "Nama rapat minimal 3 karakter.", "error"); return; }
  const save = $("#meeting-save"); save.disabled = true; save.textContent = "Menyimpan…"; setFeedback($("#meeting-form-feedback"), "");
  try {
    let error; const wasEditing = Boolean(state.editingMeetingId); const editingId = state.editingMeetingId;
    if (wasEditing) {
      ({ error } = await supabase.rpc("admin_update_meeting", { p_meeting_id: editingId, p_title: payload.title, p_meeting_date: payload.meeting_date, p_start_time: payload.start_time, p_notes: payload.notes }));
    } else {
      ({ error } = await supabase.from("meetings").insert({ ...payload, status: "scheduled", created_by: state.user.id }));
    }
    if (error) throw error;
    resetMeetingForm(); await loadData(); showFeedback(wasEditing ? "Perubahan rapat disimpan." : "Rapat berhasil dibuat.", "success");
  } catch (error) { setFeedback($("#meeting-form-feedback"), safeError(error), "error"); }
  finally { save.disabled = false; if (state.editingMeetingId) save.textContent = "Simpan perubahan"; else save.textContent = "Simpan rapat"; }
}
function editMeeting(meeting) {
  if (!meeting || meeting.status === "closed") return;
  state.editingMeetingId = meeting.id; $("#meeting-form-title").textContent = "Edit detail rapat"; $("#meeting-save").textContent = "Simpan perubahan"; $("#meeting-cancel-edit").hidden = false;
  $("#meeting-title").value = meeting.title; $("#meeting-date").value = meeting.meeting_date; $("#meeting-time").value = meeting.start_time ? String(meeting.start_time).slice(0,5) : ""; $("#meeting-notes").value = meeting.notes || ""; $("#meeting-title").focus();
}
async function changeMeetingStatus(meeting, newStatus) {
  const title = newStatus === "open" ? "Buka presensi?" : "Tutup presensi?";
  const message = newStatus === "open" ? `Sesi presensi untuk “${meeting.title}” akan dibuka. QR unik akan dibuat untuk rapat ini.` : `Sesi “${meeting.title}” akan ditutup. Peserta tidak dapat melakukan check-in lagi setelah sesi ditutup.`;
  askConfirm(title, message, newStatus === "open" ? "Buka presensi" : "Tutup presensi", async () => {
    try {
      const { error } = await supabase.rpc("admin_set_meeting_status", { p_meeting_id: meeting.id, p_new_status: newStatus }); if (error) throw error;
      await loadData(); showFeedback(newStatus === "open" ? "Presensi berhasil dibuka. QR sesi sudah tersedia." : "Presensi berhasil ditutup.", "success");
      if (newStatus === "open") await showQr(getMeeting(meeting.id));
    } catch (error) { showFeedback(safeError(error), "error"); }
  }, newStatus === "closed");
}
async function toggleProgram(program) {
  try { const { error } = await supabase.from("study_programs").update({ is_active: !program.is_active }).eq("id", program.id); if (error) throw error; await loadData(); showFeedback(`Program studi ${program.is_active ? "dinonaktifkan" : "diaktifkan"}.`, "success"); }
  catch (error) { showFeedback(safeError(error), "error"); }
}
function exportCsv() {
  const rows = filteredAttendance();
  if (!rows.length) { showFeedback("Tidak ada data untuk diekspor dengan filter saat ini.", "error"); return; }
  const headings = ["Judul rapat", "Tanggal rapat", "Nama peserta", "Program studi", "Status kehadiran", "Waktu check-in (Asia/Makassar, UTC+08:00)"];
  const csvCell = (value) => {
    const raw = String(value ?? "");
    // Prevent spreadsheet formula execution from untrusted participant/program names.
    const safeValue = /^[\s]*[=+\-@]/.test(raw) ? "'" + raw : raw;
    return `"${safeValue.replace(/"/g, '""')}"`;
  };
  const lines = [headings, ...rows.map((entry) => {
    const meeting = getMeeting(entry.meeting_id);
    const checkedInWita = entry.checked_in_at
      ? new Date(new Date(entry.checked_in_at).getTime() + 8 * 60 * 60 * 1000).toISOString().replace("Z", "+08:00")
      : "";
    return [meeting?.title || "Rapat tidak ditemukan", meeting?.meeting_date || "", entry.full_name, entry.study_program_name || getProgramName(entry.study_program_id), "Hadir", checkedInWita];
  })].map((row) => row.map(csvCell).join(",")).join("\r\n");
  const blob = new Blob(["\ufeff", lines], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url; link.download = `gladius-presensi-${localTodayISO()}.csv`;
  document.body.append(link); link.click(); link.remove(); URL.revokeObjectURL(url);
  showFeedback(`${rows.length} catatan diekspor ke CSV. Timestamp menggunakan ISO 8601 dengan offset WITA (+08:00).`, "success");
}

function setupRealtime() {
  if (!supabase || !state.user || state.channel) return;
  const queueRefresh = () => {
    window.clearTimeout(refreshTimeout);
    refreshTimeout = window.setTimeout(() => {
      if (document.visibilityState === "visible") loadData().catch((error) => showFeedback(safeError(error), "error"));
    }, 500);
  };
  state.channel = supabase.channel("gladius-admin-updates")
    .on("postgres_changes", { event: "*", schema: "public", table: "attendance" }, queueRefresh)
    .on("postgres_changes", { event: "*", schema: "public", table: "meetings" }, queueRefresh)
    .on("postgres_changes", { event: "*", schema: "public", table: "study_programs" }, queueRefresh)
    .subscribe((status) => {
      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") showFeedback("Pembaruan langsung terputus. Buka ulang dashboard untuk memuat data terbaru.", "error");
    });
}

async function init() {
  if (!supabase) {
    document.querySelectorAll("button, input, select, textarea").forEach((control) => { control.disabled = true; });
    showFeedback("Aplikasi belum dikonfigurasi. Isi URL dan publishable key Supabase di js/config.js sesuai README.md.", "error");
    return;
  }
  $("#today-label").textContent = new Intl.DateTimeFormat("id-ID", { weekday: "short", day: "numeric", month: "short", timeZone: "Asia/Makassar" }).format(new Date());
  if (!(await verifyAdmin())) return;
  await loadData(); resetMeetingForm(); setupRealtime();
}

$("#logout-button").addEventListener("click", async () => { await supabase.auth.signOut(); location.replace("login.html"); });
document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => setView(button.dataset.view)));
document.addEventListener("click", (event) => {
  const go = event.target.closest("[data-go-view]"); if (go) setView(go.dataset.goView);
  const close = event.target.closest("[data-close-dialog]"); if (close) $("#" + close.dataset.closeDialog).close();
  const action = event.target.closest("[data-action]"); if (!action) return;
  const { action: kind, id } = action.dataset;
  if (kind === "show-qr") showQr(getMeeting(id));
  if (kind === "open") changeMeetingStatus(getMeeting(id), "open");
  if (kind === "close") changeMeetingStatus(getMeeting(id), "closed");
  if (kind === "edit") { setView("meetings"); editMeeting(getMeeting(id)); }
  if (kind === "view-attendance") { setView("attendance"); $("#attendance-meeting-filter").value = id; renderAttendance(); }
  if (kind === "toggle-program") { const program = state.programs.find((item) => item.id === id); if (program) toggleProgram(program); }
});
$("#meeting-form").addEventListener("submit", handleMeetingForm);
$("#meeting-cancel-edit").addEventListener("click", resetMeetingForm);
$("#attendance-search").addEventListener("input", renderAttendance);
$("#attendance-meeting-filter").addEventListener("change", renderAttendance);
$("#attendance-program-filter").addEventListener("change", renderAttendance);
$("#export-csv").addEventListener("click", exportCsv);
$("#confirm-action").addEventListener("click", async () => { const dialog = $("#confirm-dialog"); const callback = state.confirmHandler; state.confirmHandler = null; dialog.close(); if (callback) await callback(); });
$("#copy-qr-link").addEventListener("click", async () => { try { await navigator.clipboard.writeText($("#qr-link").value); setFeedback($("#qr-feedback"), "Tautan berhasil disalin.", "success"); } catch { $("#qr-link").select(); setFeedback($("#qr-feedback"), "Salin tautan secara manual menggunakan menu perangkat.", "error"); } });
$("#program-form").addEventListener("submit", async (event) => {
  event.preventDefault(); const form = event.currentTarget; const name = form.elements.namedItem("name").value.trim().replace(/\s+/g, " ");
  if (name.length < 2) { setFeedback($("#program-form-feedback"), "Nama program studi minimal 2 karakter.", "error"); return; }
  const button = form.querySelector("button[type=submit]"); button.disabled = true;
  try { const { error } = await supabase.from("study_programs").insert({ name, is_active: true }); if (error) { if (error.code === "23505") throw new Error("Program studi dengan nama tersebut sudah ada."); throw error; } form.reset(); await loadData(); setFeedback($("#program-form-feedback"), "Program studi ditambahkan.", "success"); }
  catch (error) { setFeedback($("#program-form-feedback"), error.message === "Program studi dengan nama tersebut sudah ada." ? error.message : safeError(error), "error"); }
  finally { button.disabled = false; }
});
if (supabase) {
  supabase.auth.onAuthStateChange((event) => { if (event === "SIGNED_OUT") location.replace("login.html"); });
  window.addEventListener("focus", () => { if (state.user) loadData().catch((error) => showFeedback(safeError(error), "error")); });
}
init().catch((error) => { showFeedback(safeError(error), "error"); if (/Konfigurasi Supabase/.test(error.message)) showFeedback(error.message, "error"); });
