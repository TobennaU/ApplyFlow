import { supabase } from "./Supabaseclient.js";

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


// authentication

async function signUp() {
  const email = $("authEmail").value.trim();
  const password = $("authPassword").value;
  const name = $("authName").value.trim();

  const { error } = await supabase.auth.signUp({
    email,
    password,
    options: { data: { name } },
  });

  if (error) return showError(error, "Could not sign up.");
  alert("Account created. Check your email if confirmation is turned on.");
}

async function signIn() {
  const email = $("authEmail").value.trim();
  const password = $("authPassword").value;

  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) showError(error, "Could not sign in.");
}

async function signOut() {
  await supabase.auth.signOut();
}

// runs on page load, login, logout and token refresh
supabase.auth.onAuthStateChange((_event, session) => {
  currentUser = session?.user ?? null;

  $("authBox").hidden = Boolean(currentUser);
  $("appBox").hidden = !currentUser;
  $("signOutBtn").hidden = !currentUser;
  $("userEmail").textContent = currentUser?.email ?? "";

  if (currentUser) {
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

  const { error } = await supabase.from("applications").insert({
    user_id: currentUser.id,
    company,
    job_title: title,
    application_status: status,
    notes,
  });

  if (error) return showError(error, "Could not save application.");

  $("company").value = "";
  $("title").value = "";
  $("notes").value = "";

  loadApplications();
}

async function loadApplications() {
  const filter = $("filter").value;

  let query = supabase
    .from("applications")
    .select("id, company, job_title, application_status, notes, application_date")
    .order("created_at", { ascending: false });

  if (filter !== "All") {
    query = query.eq("application_status", filter);
  }

  const { data, error } = await query;
  if (error) return showError(error, "Could not load applications.");

  displayApplications(data);
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
  const { error } = await supabase.from("applications").delete().eq("id", id);
  if (error) return showError(error, "Could not delete application.");
  loadApplications();
}


// job listings 

async function loadJobs() {
  const { data, error } = await supabase
    .from("job_listings")
    .select("id, title, company, location")
    .order("created_at", { ascending: false })
    .limit(20);

  if (error) return showError(error, "Could not load jobs.");

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
  const { error } = await supabase.from("saved_jobs").insert({
    user_id: currentUser.id,
    job_listing_id: job.id,
  });

  // 23505 is a duplicate, which just means they already saved it
  if (error && error.code !== "23505") {
    return showError(error, "Could not save job.");
  }

  alert(error ? "Already in your saved jobs." : "Job saved.");
}


// resumes 

async function uploadResume() {
  const file = $("resumeFile").files[0];
  if (!file) return alert("Choose a file first.");

  // the first folder has to be the user's id or the storage policy rejects it
  const path = `${currentUser.id}/${Date.now()}-${file.name}`;

  const { error: uploadError } = await supabase.storage
    .from("resumes")
    .upload(path, file);

  if (uploadError) return showError(uploadError, "Upload failed.");

  const { error } = await supabase.from("resumes").insert({
    user_id: currentUser.id,
    file_name: file.name,
    file_path: path,
  });

  if (error) return showError(error, "Could not record resume.");
  alert("Resume uploaded.");
}

// private bucket, so links have to be generated and expire
export async function getResumeLink(filePath) {
  const { data, error } = await supabase.storage
    .from("resumes")
    .createSignedUrl(filePath, 60);
  if (error) throw error;
  return data.signedUrl;
}


$("signUpBtn").addEventListener("click", signUp);
$("signInBtn").addEventListener("click", signIn);
$("signOutBtn").addEventListener("click", signOut);
$("addApplicationBtn").addEventListener("click", addApplication);
$("filter").addEventListener("change", loadApplications);
$("loadJobsBtn").addEventListener("click", loadJobs);
$("uploadResumeBtn").addEventListener("click", uploadResume);
