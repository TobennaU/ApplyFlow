import * as api from "./api.js";

const { supabase } = api;

let currentUser = null;
let loadedApplications = [];
let editingApplicationId = null;
let resumes = [];
let selectedResumeId = null;
let feedbackByApp = {};
let pendingJobListingId = null;
let lastViewKey = null;
let mfaFactorId = null;

const $ = (id) => document.getElementById(id);

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function labelled(label, value) {
  const p = document.createElement("p");
  p.appendChild(el("b", label + ": "));
  p.appendChild(document.createTextNode(value ?? ""));
  return p;
}

function showError(error, fallback) {
  console.error(error);
  alert(error?.message || fallback);
}

function setMessage(id, baseClass, message, type = "") {
  const node = $(id);
  node.textContent = message;
  node.className = `${baseClass} ${type}`.trim();
}

const showAuthMessage = (message, type) => setMessage("authMessage", "auth-message", message, type);
const showMfaMessage = (message, type) => setMessage("mfaMessage", "auth-message", message, type);
const showResumeStatus = (message, type) => setMessage("resumeStatus", "resume-status", message, type);
const showReminderMessage = (message, type) => setMessage("reminderMessage", "resume-status", message, type);
const showSecurityMessage = (message, type) => setMessage("securityMessage", "resume-status", message, type);

function setAuthLoading(loading, activeButton = null) {
  const signInButton = $("signInBtn");
  const signUpButton = $("signUpBtn");

  signInButton.disabled = loading;
  signUpButton.disabled = loading;
  signInButton.textContent = loading && activeButton === "signin" ? "Signing in..." : "Sign in";
  signUpButton.textContent = loading && activeButton === "signup" ? "Creating account..." : "Create account";
}

// dates

function parseDate(value) {
  if (!value) return null;
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function startOfToday() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function daysFromToday(date) {
  return Math.round((date - startOfToday()) / 86400000);
}

function formatDate(value) {
  const date = parseDate(value);
  return date ? date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }) : "";
}

function dayLabel(days) {
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  return `in ${days} days`;
}


// authentication

async function signUp() {
  const email = $("authEmail").value.trim();
  const password = $("authPassword").value;
  const name = $("authName").value.trim();

  if (!name || !email || !password) {
    showAuthMessage("Enter your name, email, and password to create an account.", "error");
    return;
  }

  if (password.length < 6) {
    showAuthMessage("Your password must be at least 6 characters.", "error");
    return;
  }

  setAuthLoading(true, "signup");
  showAuthMessage("");

  try {
    const result = await api.signUp(email, password, name);
    if (result.session) {
      showAuthMessage("Your account is ready.", "success");
    } else {
      showAuthMessage("Account created. Check your email to confirm your address, then sign in.", "success");
    }
  } catch (error) {
    console.error(error);
    showAuthMessage(error.message || "Could not create your account.", "error");
  } finally {
    setAuthLoading(false);
  }
}

async function signIn() {
  const email = $("authEmail").value.trim();
  const password = $("authPassword").value;

  if (!email || !password) {
    showAuthMessage("Enter your email and password to sign in.", "error");
    return;
  }

  setAuthLoading(true, "signin");
  showAuthMessage("");

  try {
    await api.signIn(email, password);
  } catch (error) {
    console.error(error);
    showAuthMessage(error.message || "Could not sign in.", "error");
  } finally {
    setAuthLoading(false);
  }
}

async function signOut() {
  try {
    await api.signOut();
  } catch (error) {
    showError(error, "Could not sign out.");
  }
}

// runs on page load, login, logout and token refresh
supabase.auth.onAuthStateChange((_event, session) => {
  currentUser = session?.user ?? null;
  // supabase calls made inside this callback can deadlock, so hand off to the next tick
  setTimeout(updateView, 0);
});

async function updateView() {
  $("signOutBtn").hidden = !currentUser;
  $("userEmail").textContent = currentUser?.email ?? "";

  if (!currentUser) {
    lastViewKey = null;
    loadedApplications = [];
    resumes = [];
    feedbackByApp = {};
    $("authBox").hidden = false;
    $("mfaBox").hidden = true;
    $("appBox").hidden = true;
    for (const id of ["applicationList", "jobList", "savedJobsList", "resumeList", "upcomingList", "insights"]) {
      $(id).replaceChildren();
    }
    return;
  }

  let mfa;
  try {
    mfa = await api.getMfaStatus();
  } catch (error) {
    console.error(error);
    mfa = { currentLevel: "aal1", nextLevel: "aal1", factors: [] };
  }

  // 2FA is on for this account but no code has been entered this session
  const needsCode = mfa.nextLevel === "aal2" && mfa.currentLevel !== "aal2";

  // token refreshes fire this too, so only rebuild when something actually changed
  const key = `${currentUser.id}:${needsCode ? "code" : "ready"}`;
  if (key === lastViewKey) return;
  lastViewKey = key;

  $("authBox").hidden = true;
  $("mfaBox").hidden = !needsCode;
  $("appBox").hidden = needsCode;

  if (needsCode) {
    mfaFactorId = mfa.factors[0]?.id ?? null;
    $("mfaCode").value = "";
    showMfaMessage("");
    return;
  }

  showAuthMessage("");
  renderSecurityPanel(mfa);
  await loadEverything();
}

async function loadEverything() {
  // resumes and feedback first, so application cards can show saved feedback
  await Promise.all([loadResumes(), loadFeedback()]);
  await Promise.all([loadApplications(), loadSavedJobs()]);
  checkReminders();
}


// two-factor authentication

async function verifyMfaCode() {
  const code = $("mfaCode").value.trim();
  if (!/^\d{6}$/.test(code)) {
    showMfaMessage("Enter the 6-digit code from your authenticator app.", "error");
    return;
  }

  try {
    await api.verifyTotp(mfaFactorId, code);
    lastViewKey = null;
    await updateView();
  } catch (error) {
    console.error(error);
    showMfaMessage(error.message || "That code did not work. Try again.", "error");
  }
}

function renderSecurityPanel(mfa) {
  const enabled = mfa.factors.length > 0;
  mfaFactorId = mfa.factors[0]?.id ?? mfaFactorId;

  $("securityStatus").textContent = enabled
    ? "Two-factor authentication is on. You will be asked for a code each time you sign in."
    : "Two-factor authentication is off. Turn it on to require a code from your phone when you sign in.";
  $("enableMfaBtn").hidden = enabled;
  $("disableMfaBtn").hidden = !enabled;
  $("mfaEnroll").hidden = true;
}

async function startMfaEnrollment() {
  showSecurityMessage("");
  try {
    const data = await api.enrollTotp();
    mfaFactorId = data.id;
    $("mfaQr").src = data.totp.qr_code;
    $("mfaSecret").textContent = data.totp.secret;
    $("mfaSetupCode").value = "";
    $("mfaEnroll").hidden = false;
    $("enableMfaBtn").hidden = true;
  } catch (error) {
    console.error(error);
    showSecurityMessage(error.message || "Could not start setup.", "error");
  }
}

async function confirmMfaEnrollment() {
  const code = $("mfaSetupCode").value.trim();
  if (!/^\d{6}$/.test(code)) {
    showSecurityMessage("Enter the 6-digit code from your authenticator app.", "error");
    return;
  }

  try {
    await api.verifyTotp(mfaFactorId, code);
    renderSecurityPanel(await api.getMfaStatus());
    showSecurityMessage("Two-factor authentication is now on.", "success");
  } catch (error) {
    console.error(error);
    showSecurityMessage(error.message || "That code did not work. Try again.", "error");
  }
}

async function turnOffMfa() {
  if (!window.confirm("Turn off two-factor authentication?")) return;

  try {
    await api.disableTotp(mfaFactorId);
    renderSecurityPanel(await api.getMfaStatus());
    showSecurityMessage("Two-factor authentication is off.", "success");
  } catch (error) {
    console.error(error);
    showSecurityMessage(error.message || "Could not turn it off.", "error");
  }
}


//  applications 

async function addApplication() {
  const company = $("company").value.trim();
  const title = $("title").value.trim();

  if (!company || !title) {
    alert("Please enter company and job title.");
    return;
  }

  try {
    await api.addApplication({
      company,
      job_title: title,
      application_status: $("status").value,
      location: $("appLocation").value.trim() || null,
      job_description: $("appDescription").value.trim() || null,
      notes: $("notes").value.trim(),
      interview_date: $("interviewDate").value || null,
      follow_up_date: $("followUpDate").value || null,
      ...(pendingJobListingId ? { job_listing_id: pendingJobListingId } : {}),
    });
  } catch (error) {
    return showError(error, "Could not save application.");
  }

  for (const id of ["company", "title", "appLocation", "appDescription", "notes", "interviewDate", "followUpDate"]) {
    $(id).value = "";
  }
  pendingJobListingId = null;

  loadApplications();
}

async function loadApplications() {
  try {
    loadedApplications = await api.listApplications();
    filterApplications();
    renderInsights();
    renderUpcoming();
  } catch (error) {
    showError(error, "Could not load applications.");
  }
}

// Search and status filtering happen locally so the list updates immediately.
function filterApplications() {
  const status = $("filter").value;
  const search = $("applicationSearch").value.trim().toLowerCase();

  const matches = loadedApplications.filter((app) => {
    const matchesStatus = status === "All" || app.application_status === status;
    const searchableText = [app.company, app.job_title, app.location, app.job_description]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return matchesStatus && searchableText.includes(search);
  });

  displayApplications(matches);
}

function displayApplications(apps) {
  const list = $("applicationList");
  list.replaceChildren();

  if (!apps || apps.length === 0) {
    list.appendChild(el("p", "No applications found."));
    return;
  }

  for (const app of apps) {
    const card = el("div", undefined, "card");
    card.appendChild(el("h3", app.job_title));
    card.appendChild(labelled("Company", app.company));
    card.appendChild(labelled("Status", app.application_status));
    if (app.location) card.appendChild(labelled("Location", app.location));
    card.appendChild(labelled("Applied", app.application_date));
    if (app.interview_date) card.appendChild(labelled("Interview", formatDate(app.interview_date)));
    if (app.follow_up_date) card.appendChild(labelled("Follow up", formatDate(app.follow_up_date)));
    card.appendChild(labelled("Notes", app.notes));

    const actions = el("div", undefined, "card-actions");

    const edit = el("button", "Edit", "edit-button");
    edit.addEventListener("click", () => openEditApplication(app));
    actions.appendChild(edit);

    const del = el("button", "Delete", "delete-button");
    del.addEventListener("click", () => deleteApplication(app.id));
    actions.appendChild(del);

    const feedbackBox = el("div", undefined, "feedback-box");
    const saved = feedbackByApp[app.id];
    const feedbackBtn = el("button", saved ? "Refresh AI Feedback" : "Get AI Feedback", "ai-button");
    feedbackBtn.addEventListener("click", () => getFeedback(app.id, feedbackBtn, feedbackBox));
    actions.appendChild(feedbackBtn);
    if (saved) renderFeedback(feedbackBox, saved);

    card.appendChild(actions);
    card.appendChild(feedbackBox);

    list.appendChild(card);
  }
}

async function deleteApplication(id) {
  const application = loadedApplications.find((app) => app.id === id);
  const label = application ? `${application.job_title} at ${application.company}` : "this application";

  if (!window.confirm(`Delete ${label}? This cannot be undone.`)) return;

  try {
    await api.deleteApplication(id);
    delete feedbackByApp[id];
    loadApplications();
  } catch (error) {
    showError(error, "Could not delete application.");
  }
}

function openEditApplication(application) {
  editingApplicationId = application.id;
  $("editCompany").value = application.company;
  $("editTitle").value = application.job_title;
  $("editStatus").value = application.application_status;
  $("editLocation").value = application.location ?? "";
  $("editInterview").value = application.interview_date ?? "";
  $("editFollowUp").value = application.follow_up_date ?? "";
  $("editDescription").value = application.job_description ?? "";
  $("editNotes").value = application.notes ?? "";
  $("editMessage").textContent = "";
  $("editApplicationDialog").showModal();
}

function closeEditApplication() {
  editingApplicationId = null;
  $("editApplicationDialog").close();
}

async function saveApplicationChanges(event) {
  event.preventDefault();

  const company = $("editCompany").value.trim();
  const title = $("editTitle").value.trim();
  const saveButton = $("saveEditBtn");

  if (!company || !title) {
    $("editMessage").textContent = "Enter both a company and job title.";
    return;
  }

  saveButton.disabled = true;
  saveButton.textContent = "Saving...";
  $("editMessage").textContent = "";

  try {
    await api.updateApplication(editingApplicationId, {
      company,
      job_title: title,
      application_status: $("editStatus").value,
      location: $("editLocation").value.trim() || null,
      interview_date: $("editInterview").value || null,
      follow_up_date: $("editFollowUp").value || null,
      job_description: $("editDescription").value.trim() || null,
      notes: $("editNotes").value.trim(),
    });
    closeEditApplication();
    await loadApplications();
  } catch (error) {
    console.error(error);
    $("editMessage").textContent = error.message || "Could not update the application.";
  } finally {
    saveButton.disabled = false;
    saveButton.textContent = "Save changes";
  }
}

// fills the add form from a job listing, so the user can set status and dates
function trackJob(job) {
  $("company").value = job.company ?? "";
  $("title").value = job.title ?? "";
  $("appLocation").value = job.location ?? "";
  $("appDescription").value = job.description ?? "";
  $("status").value = "Applied";
  pendingJobListingId = job.id;
  $("new-application").scrollIntoView({ behavior: "smooth" });
}


// reminders and calendar

function upcomingItems() {
  const items = [];
  for (const app of loadedApplications) {
    if (app.application_status === "Rejected") continue;
    for (const [type, value] of [["Interview", app.interview_date], ["Follow up", app.follow_up_date]]) {
      if (!value) continue;
      const days = daysFromToday(parseDate(value));
      if (days >= 0 && days <= 14) items.push({ app, type, value, days });
    }
  }
  return items.sort((a, b) => a.days - b.days);
}

function renderUpcoming() {
  const box = $("upcomingList");
  box.replaceChildren();

  const items = upcomingItems();
  if (items.length === 0) {
    box.appendChild(el("p", "Nothing due in the next 14 days. Add an interview or follow-up date to an application to see it here.", "panel-copy"));
    return;
  }

  for (const item of items) {
    const row = el("div", undefined, "upcoming-item");
    const text = el("div");
    text.appendChild(el("strong", `${item.type}: ${item.app.job_title}`));
    text.appendChild(el("small", item.app.company));
    row.appendChild(text);
    row.appendChild(el("span", `${formatDate(item.value)} (${dayLabel(item.days)})`, item.days <= 1 ? "due-soon" : ""));
    box.appendChild(row);
  }
}

function checkReminders() {
  if (!("Notification" in window) || Notification.permission !== "granted") return;

  for (const item of upcomingItems().filter((entry) => entry.days <= 1)) {
    const key = `applyflow-notified:${item.app.id}:${item.type}:${item.value}:${new Date().toDateString()}`;
    try {
      if (localStorage.getItem(key)) continue;
      localStorage.setItem(key, "1");
    } catch (_) {}
    new Notification(`${item.type} ${dayLabel(item.days)}`, {
      body: `${item.app.job_title} at ${item.app.company}`,
    });
  }
}

async function enableReminders() {
  if (!("Notification" in window)) {
    showReminderMessage("This browser does not support notifications.", "error");
    return;
  }

  const permission = await Notification.requestPermission();
  if (permission === "granted") {
    showReminderMessage("Reminders are on. You will get a notification for anything due today or tomorrow when ApplyFlow is open.", "success");
    checkReminders();
  } else {
    showReminderMessage("Notifications are blocked. Allow them in your browser settings to turn reminders on.", "error");
  }
}

function icsDate(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}

function icsText(text) {
  return String(text).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}

function downloadCalendar() {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
  const events = [];

  for (const app of loadedApplications) {
    for (const [type, value] of [["Interview", app.interview_date], ["Follow up", app.follow_up_date]]) {
      if (!value) continue;
      const start = parseDate(value);
      if (daysFromToday(start) < 0) continue;
      const end = new Date(start);
      end.setDate(end.getDate() + 1);

      events.push(
        "BEGIN:VEVENT",
        `UID:${app.id}-${type.replace(" ", "").toLowerCase()}@applyflow`,
        `DTSTAMP:${stamp}`,
        `DTSTART;VALUE=DATE:${icsDate(start)}`,
        `DTEND;VALUE=DATE:${icsDate(end)}`,
        `SUMMARY:${icsText(`${type}: ${app.job_title} at ${app.company}`)}`,
        "END:VEVENT"
      );
    }
  }

  if (events.length === 0) {
    showReminderMessage("There are no upcoming interview or follow-up dates to export.", "error");
    return;
  }

  const calendar = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//ApplyFlow//EN", ...events, "END:VCALENDAR"].join("\r\n");
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([calendar], { type: "text/calendar" }));
  link.download = "applyflow-calendar.ics";
  link.click();
  URL.revokeObjectURL(link.href);
  showReminderMessage("Calendar file downloaded. Open it to add the dates to Google, Apple, or Outlook Calendar.", "success");
}


// insights

function renderInsights() {
  const box = $("insights");
  box.replaceChildren();

  const apps = loadedApplications;
  const total = apps.length;

  if (total === 0) {
    box.appendChild(el("p", "Add some applications and your statistics will show up here.", "panel-copy"));
    return;
  }

  const count = (status) => apps.filter((app) => app.application_status === status).length;
  const interview = count("Interview");
  const offer = count("Offer");
  const rejected = count("Rejected");
  const percent = (n) => `${Math.round((n / total) * 100)}%`;

  const stats = el("div", undefined, "stat-row");
  for (const [label, value] of [
    ["Applications", String(total)],
    ["Response rate", percent(interview + offer + rejected)],
    ["Interview rate", percent(interview + offer)],
    ["Offer rate", percent(offer)],
  ]) {
    const stat = el("div", undefined, "stat");
    stat.appendChild(el("strong", value));
    stat.appendChild(el("small", label));
    stats.appendChild(stat);
  }
  box.appendChild(stats);

  const bars = el("div", undefined, "status-bars");
  for (const status of ["Applied", "Interview", "Offer", "Rejected"]) {
    const n = count(status);
    const row = el("div", undefined, "bar-row");
    row.appendChild(el("span", status));
    const track = el("div", undefined, "bar-track");
    const fill = el("div", undefined, `bar-fill ${status.toLowerCase()}`);
    fill.style.width = `${(n / total) * 100}%`;
    track.appendChild(fill);
    row.appendChild(track);
    row.appendChild(el("b", String(n)));
    bars.appendChild(row);
  }
  box.appendChild(bars);

  // applications per week for the last 8 weeks
  const weeks = Array(8).fill(0);
  for (const app of apps) {
    const date = parseDate(app.application_date);
    if (!date) continue;
    const age = -daysFromToday(date);
    if (age >= 0 && age < 56) weeks[Math.floor(age / 7)]++;
  }
  const max = Math.max(1, ...weeks);

  box.appendChild(el("p", "Applications per week", "chart-title"));
  const chart = el("div", undefined, "weekly");
  for (let i = 7; i >= 0; i--) {
    const column = el("div", undefined, "weekly-col");
    const bar = el("div", undefined, "weekly-bar");
    bar.style.height = `${Math.max(2, Math.round((weeks[i] / max) * 70))}px`;
    column.appendChild(el("span", String(weeks[i])));
    column.appendChild(bar);
    column.appendChild(el("small", i === 0 ? "now" : `-${i}w`));
    chart.appendChild(column);
  }
  box.appendChild(chart);
  box.appendChild(el("p", "Response rate counts anything past Applied. Interview rate counts Interview and Offer.", "chart-note"));
}


// job listings 

async function loadJobs() {
  const keyword = $("jobKeyword").value.trim();
  const location = $("jobLocation").value.trim();
  const button = $("loadJobsBtn");
  const originalLabel = button.innerHTML;

  button.disabled = true;
  button.textContent = "Loading...";

  try {
    // pull new postings first (plain browsing only refreshes stale sources)
    try {
      await api.refreshJobs({ keyword, location });
    } catch (error) {
      console.error("Could not refresh job listings:", error);
    }

    let data;
    try {
      const batches = await Promise.all([
        api.listJobs({ limit: 12, source: "usajobs", search: keyword, location }),
        api.listJobs({ limit: 12, source: "remotive", search: keyword, location }),
      ]);
      data = batches.flat();
    } catch (error) {
      return showError(error, "Could not load jobs.");
    }

    const jobList = $("jobList");
    jobList.replaceChildren();

    if (data.length === 0) {
      jobList.appendChild(el("p", "No job listings matched. Try a different keyword or location.", "job-empty"));
      return;
    }

    for (const job of data) {
      const card = el("div", undefined, "card");
      card.appendChild(el("h3", job.title));
      card.appendChild(labelled("Company", job.company));
      card.appendChild(labelled("Location", job.location));

      if (job.job_url?.startsWith("https://")) {
        const sourceName = job.source === "usajobs" ? "USAJOBS" : "Remotive";
        const link = el("a", `View posting on ${sourceName}`);
        link.href = job.job_url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        card.appendChild(link);
      }

      const actions = el("div", undefined, "card-actions");
      const save = el("button", "Save Job", "primary-button");
      save.addEventListener("click", () => saveJob(job));
      actions.appendChild(save);

      const track = el("button", "Track Application", "edit-button");
      track.addEventListener("click", () => trackJob(job));
      actions.appendChild(track);
      card.appendChild(actions);

      jobList.appendChild(card);
    }
  } finally {
    button.disabled = false;
    button.innerHTML = originalLabel;
  }
}

async function saveJob(job) {
  try {
    await api.saveJob(job.id);
    alert("Job saved.");
    loadSavedJobs();
  } catch (error) {
    if (error.message?.toLowerCase().includes("duplicate")) {
      alert("Already in your saved jobs.");
      return;
    }
    showError(error, "Could not save job.");
  }
}


// saved jobs

async function loadSavedJobs() {
  const list = $("savedJobsList");

  let saved;
  try {
    saved = await api.listSavedJobs();
  } catch (error) {
    console.error(error);
    return;
  }

  list.replaceChildren();

  const jobs = saved.map((row) => row.job_listings).filter(Boolean);
  if (jobs.length === 0) {
    const empty = el("div", undefined, "empty-state");
    empty.appendChild(el("h3", "No saved jobs yet"));
    empty.appendChild(el("p", "Save a listing from the job explorer below and it will show up here."));
    list.appendChild(empty);
    return;
  }

  for (const job of jobs) {
    const card = el("div", undefined, "card");
    card.appendChild(el("h3", job.title));
    card.appendChild(labelled("Company", job.company));
    card.appendChild(labelled("Location", job.location));

    if (job.job_url?.startsWith("https://")) {
      const sourceName = job.source === "usajobs" ? "USAJOBS" : "Remotive";
      const link = el("a", `View posting on ${sourceName}`);
      link.href = job.job_url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      card.appendChild(link);
    }

    const actions = el("div", undefined, "card-actions");

    const track = el("button", "Track Application", "edit-button");
    track.addEventListener("click", () => trackJob(job));
    actions.appendChild(track);

    const remove = el("button", "Remove", "delete-button");
    remove.addEventListener("click", () => removeSavedJob(job.id));
    actions.appendChild(remove);

    card.appendChild(actions);
    list.appendChild(card);
  }
}

async function removeSavedJob(jobId) {
  try {
    await api.unsaveJob(jobId);
    loadSavedJobs();
  } catch (error) {
    showError(error, "Could not remove the saved job.");
  }
}


// resumes 

async function loadResumes() {
  try {
    resumes = await api.listResumes();
  } catch (error) {
    console.error(error);
    resumes = [];
  }

  if (!resumes.some((resume) => resume.id === selectedResumeId)) {
    selectedResumeId = resumes[0]?.id ?? null;
  }
  renderResumes();
}

function renderResumes() {
  const list = $("resumeList");
  list.replaceChildren();

  if (resumes.length === 0) {
    showResumeStatus("");
    return;
  }

  for (const resume of resumes) {
    const item = el("li", undefined, "resume-item");

    const choice = el("label", undefined, "resume-choice");
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "resumeChoice";
    radio.checked = resume.id === selectedResumeId;
    radio.addEventListener("change", () => {
      selectedResumeId = resume.id;
      renderResumes();
    });
    choice.appendChild(radio);

    const text = el("span", undefined, "resume-text");
    text.appendChild(el("strong", resume.file_name));
    const readable = resume.parsed_text ? "text found" : "no readable text";
    text.appendChild(el("small", `${new Date(resume.uploaded_at).toLocaleDateString()} · ${readable}`));
    choice.appendChild(text);
    item.appendChild(choice);

    const remove = el("button", "Delete", "resume-delete");
    remove.type = "button";
    remove.addEventListener("click", () => removeResume(resume));
    item.appendChild(remove);

    list.appendChild(item);
  }

  const selected = resumes.find((resume) => resume.id === selectedResumeId);
  if (selected?.parsed_text) {
    showResumeStatus(`AI feedback will use ${selected.file_name}.`, "success");
  } else if (selected) {
    showResumeStatus(`${selected.file_name} has no readable text, so AI feedback won't work with it. Upload a PDF or Word (.docx) file with selectable text.`, "error");
  }
}

async function uploadResume() {
  const file = $("resumeFile").files[0];
  if (!file) return alert("Choose a file first.");

  const button = $("uploadResumeBtn");
  button.disabled = true;
  button.textContent = "Uploading...";

  try {
    const saved = await api.uploadResume(file);
    $("resumeFile").value = "";
    selectedResumeId = saved.id;
    await loadResumes();
  } catch (error) {
    showError(error, "Upload failed.");
  } finally {
    button.disabled = false;
    button.textContent = "Upload resume";
  }
}

async function removeResume(resume) {
  if (!window.confirm(`Delete ${resume.file_name}? Any AI feedback based on it will be deleted too.`)) return;

  try {
    await api.deleteResume(resume);
    await Promise.all([loadResumes(), loadFeedback()]);
    filterApplications();
  } catch (error) {
    showError(error, "Could not delete the resume.");
  }
}

// private bucket, so links have to be generated and expire
export async function getResumeLink(filePath) {
  return api.getResumeUrl(filePath);
}


// ai feedback

async function loadFeedback() {
  try {
    const rows = await api.listFeedback(); // newest first
    feedbackByApp = {};
    for (const row of rows) {
      if (!feedbackByApp[row.application_id]) feedbackByApp[row.application_id] = row;
    }
  } catch (error) {
    console.error("Could not load saved feedback:", error);
  }
}

function renderFeedback(box, row) {
  box.replaceChildren();
  const rec = row.recommendations;

  box.appendChild(el("p", `Match score: ${rec.match_score}/100`, "score"));

  const source = resumes.find((resume) => resume.id === row.resume_id);
  const when = new Date(row.created_at).toLocaleDateString();
  box.appendChild(el("p", `Based on ${source ? source.file_name : "an earlier resume"} · ${when}`, "feedback-meta"));

  for (const [title, items] of [
    ["Strengths", rec.strengths],
    ["Gaps", rec.gaps],
    ["Suggestions", rec.suggestions],
  ]) {
    if (!items?.length) continue;
    box.appendChild(el("b", title));
    const ul = document.createElement("ul");
    for (const item of items) ul.appendChild(el("li", item));
    box.appendChild(ul);
  }
}

async function getFeedback(applicationId, button, box) {
  const resume = resumes.find((entry) => entry.id === selectedResumeId);
  if (!resume) return alert("Upload a resume first.");
  if (!resume.parsed_text) {
    return alert("The selected resume has no readable text. Upload a PDF or Word (.docx) file with selectable text.");
  }

  const originalLabel = button.textContent;
  button.disabled = true;
  button.textContent = "Thinking...";

  try {
    const row = await api.getFeedback(resume.id, applicationId);
    feedbackByApp[applicationId] = row;
    renderFeedback(box, row);
    button.textContent = "Refresh AI Feedback";
  } catch (error) {
    button.textContent = originalLabel;
    showError(error, "Could not get feedback.");
  } finally {
    button.disabled = false;
  }
}


$("signUpBtn").addEventListener("click", signUp);
$("signInBtn").addEventListener("click", signIn);
$("signOutBtn").addEventListener("click", signOut);
$("mfaVerifyBtn").addEventListener("click", verifyMfaCode);
$("mfaCancelBtn").addEventListener("click", signOut);
$("enableMfaBtn").addEventListener("click", startMfaEnrollment);
$("confirmMfaBtn").addEventListener("click", confirmMfaEnrollment);
$("disableMfaBtn").addEventListener("click", turnOffMfa);
$("addApplicationBtn").addEventListener("click", addApplication);
$("filter").addEventListener("change", filterApplications);
$("applicationSearch").addEventListener("input", filterApplications);
$("editApplicationForm").addEventListener("submit", saveApplicationChanges);
$("closeEditBtn").addEventListener("click", closeEditApplication);
$("cancelEditBtn").addEventListener("click", closeEditApplication);
$("downloadCalendarBtn").addEventListener("click", downloadCalendar);
$("enableRemindersBtn").addEventListener("click", enableReminders);
$("loadJobsBtn").addEventListener("click", loadJobs);
$("uploadResumeBtn").addEventListener("click", uploadResume);
$("resumeFile").addEventListener("change", () => {
  const file = $("resumeFile").files[0];
  if (file) showResumeStatus(`Selected: ${file.name}. Click Upload resume to save it.`);
});