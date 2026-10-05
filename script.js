import * as api from "./api.js";

const { supabase } = api;

let currentUser = null;

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

function showAuthMessage(message, type = "") {
  const status = $("authMessage");
  status.textContent = message;
  status.className = `auth-message ${type}`.trim();
}

function setAuthLoading(loading, activeButton = null) {
  const signInButton = $("signInBtn");
  const signUpButton = $("signUpBtn");

  signInButton.disabled = loading;
  signUpButton.disabled = loading;
  signInButton.textContent = loading && activeButton === "signin" ? "Signing in..." : "Sign in";
  signUpButton.textContent = loading && activeButton === "signup" ? "Creating account..." : "Create account";
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

  $("authBox").hidden = Boolean(currentUser);
  $("appBox").hidden = !currentUser;
  $("signOutBtn").hidden = !currentUser;
  $("userEmail").textContent = currentUser?.email ?? "";

  if (currentUser) {
    showAuthMessage("");
    loadApplications();
  } else {
    $("applicationList").replaceChildren();
    $("jobList").replaceChildren();
  }
});


//  applications 

async function addApplication() {
  const company = $("company").value.trim();
  const title = $("title").value.trim();
  const status = $("status").value;
  const notes = $("notes").value.trim();

  if (!company || !title) {
    alert("Please enter company and job title.");
    return;
  }

  try {
    await api.addApplication({
      company,
      job_title: title,
      application_status: status,
      notes,
    });
  } catch (error) {
    return showError(error, "Could not save application.");
  }

  $("company").value = "";
  $("title").value = "";
  $("notes").value = "";

  loadApplications();
}

async function loadApplications() {
  const filter = $("filter").value;

  try {
    const applications = await api.listApplications(filter === "All" ? null : filter);
    displayApplications(applications);
  } catch (error) {
    showError(error, "Could not load applications.");
  }
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
    card.appendChild(labelled("Applied", app.application_date));
    card.appendChild(labelled("Notes", app.notes));

    const del = el("button", "Delete");
    del.addEventListener("click", () => deleteApplication(app.id));
    card.appendChild(del);

    list.appendChild(card);
  }
}

async function deleteApplication(id) {
  try {
    await api.deleteApplication(id);
    loadApplications();
  } catch (error) {
    showError(error, "Could not delete application.");
  }
}


// job listings 

async function loadJobs() {
  let data;
  try {
    data = await api.listJobs({ limit: 20 });
  } catch (error) {
    return showError(error, "Could not load jobs.");
  }

  const jobList = $("jobList");
  jobList.replaceChildren();

  if (data.length === 0) {
    jobList.appendChild(el("p", "No job listings yet."));
    return;
  }

  for (const job of data) {
    const card = el("div", undefined, "card");
    card.appendChild(el("h3", job.title));
    card.appendChild(labelled("Company", job.company));
    card.appendChild(labelled("Location", job.location));

    const save = el("button", "Save Job");
    save.addEventListener("click", () => saveJob(job));
    card.appendChild(save);

    jobList.appendChild(card);
  }
}

async function saveJob(job) {
  try {
    await api.saveJob(job.id);
    alert("Job saved.");
  } catch (error) {
    if (error.message?.toLowerCase().includes("duplicate")) {
      alert("Already in your saved jobs.");
      return;
    }
    showError(error, "Could not save job.");
  }
}


// resumes 

async function uploadResume() {
  const file = $("resumeFile").files[0];
  if (!file) return alert("Choose a file first.");

  try {
    await api.uploadResume(file);
    $("resumeFile").value = "";
    alert("Resume uploaded.");
  } catch (error) {
    showError(error, "Upload failed.");
  }
}

// private bucket, so links have to be generated and expire
export async function getResumeLink(filePath) {
  return api.getResumeUrl(filePath);
}


$("signUpBtn").addEventListener("click", signUp);
$("signInBtn").addEventListener("click", signIn);
$("signOutBtn").addEventListener("click", signOut);
$("addApplicationBtn").addEventListener("click", addApplication);
$("filter").addEventListener("change", loadApplications);
$("loadJobsBtn").addEventListener("click", loadJobs);
$("uploadResumeBtn").addEventListener("click", uploadResume);
