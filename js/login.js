import { supabase, setFeedback, safeError } from "./supabase.js";

const form = document.querySelector("#login-form");
const feedback = document.querySelector("#login-feedback");
const submit = document.querySelector("#login-submit");
async function redirectIfAdmin() {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return;
  const { data: profile, error } = await supabase.from("profiles").select("role").eq("id", session.user.id).maybeSingle();
  if (!error && profile?.role === "admin") location.replace("admin.html");
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!supabase) { setFeedback(feedback, "Aplikasi belum dikonfigurasi. Isi URL dan publishable key Supabase di js/config.js.", "error"); return; }
  if (!navigator.onLine) { setFeedback(feedback, "Kamu sedang offline. Sambungkan internet untuk masuk.", "error"); return; }
  const email = form.email.value.trim();
  const password = form.password.value;
  submit.disabled = true; submit.textContent = "Memeriksa akun…"; setFeedback(feedback, "");
  try {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
    const { data: profile, error: profileError } = await supabase.from("profiles").select("role").eq("id", data.user.id).maybeSingle();
    if (profileError || profile?.role !== "admin") {
      await supabase.auth.signOut();
      setFeedback(feedback, "Akun ini belum memiliki akses administrator. Hubungi pengelola.", "error");
      return;
    }
    location.replace("admin.html");
  } catch (error) {
    setFeedback(feedback, safeError(error), "error");
  } finally {
    submit.disabled = false; submit.textContent = "Masuk ke dashboard";
  }
});

if (!supabase) { submit.disabled = true; setFeedback(feedback, "Aplikasi belum dikonfigurasi. Isi URL dan publishable key Supabase di js/config.js sesuai README.md.", "error"); }
redirectIfAdmin().catch(() => {});
