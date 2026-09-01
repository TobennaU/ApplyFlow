let applications = [];

function addApplication() {
  let company = document.getElementById("company").value;
  let title = document.getElementById("title").value;
  let status = document.getElementById("status").value;
  let notes = document.getElementById("notes").value;

  if (company === "" || title === "") {
    alert("Please enter company and job title.");
    return;
  }

  let application = {
    id: Date.now(),
    company: company,
    title: title,
    status: status,
    notes: notes
  };

  applications.push(application);
  saveApplications();
  displayApplications();

  document.getElementById("company").value = "";
  document.getElementById("title").value = "";
  document.getElementById("notes").value = "";
}

function displayApplications() {
  let list = document.getElementById("applicationList");
  let filter = document.getElementById("filter").value;

  list.innerHTML = "";

  let filteredApps = applications;

  if (filter !== "All") {
    filteredApps = applications.filter(app => app.status === filter);
  }

  if (filteredApps.length === 0) {
    list.innerHTML = "<p>No applications found.</p>";
    return;
  }

  filteredApps.forEach(app => {
    let card = document.createElement("div");
    card.className = "card";

    card.innerHTML = `
      <h3>${app.title}</h3>
      <p><b>Company:</b> ${app.company}</p>
      <p><b>Status:</b> ${app.status}</p>
      <p><b>Notes:</b> ${app.notes}</p>
      <button onclick="deleteApplication(${app.id})">Delete</button>
    `;

    list.appendChild(card);
  });
}

function deleteApplication(id) {
  applications = applications.filter(app => app.id !== id);
  saveApplications();
  displayApplications();
}

function saveApplications() {
  localStorage.setItem("applications", JSON.stringify(applications));
}

function loadApplications() {
  let saved = localStorage.getItem("applications");

  if (saved) {
    applications = JSON.parse(saved);
  }

  displayApplications();
}

function loadJobs() {
  let jobList = document.getElementById("jobList");
  jobList.innerHTML = "";

  let jobs = [
    { title: "Software Developer", company: "Google", location: "California" },
    { title: "Frontend Developer", company: "Amazon", location: "Remote" },
    { title: "Backend Developer", company: "Microsoft", location: "Texas" },
    { title: "Full Stack Developer", company: "Apple", location: "New York" }
  ];

  jobs.forEach(job => {
    let card = document.createElement("div");
    card.className = "card";

    card.innerHTML = `
      <h3>${job.title}</h3>
      <p><b>Company:</b> ${job.company}</p>
      <p><b>Location:</b> ${job.location}</p>
      <button onclick="saveJob('${job.company}', '${job.title}')">Save Job</button>
    `;

    jobList.appendChild(card);
  });
}

function saveJob(company, title) {
  let application = {
    id: Date.now(),
    company: company,
    title: title,
    status: "Applied",
    notes: "Saved from sample job listings"
  };

  applications.push(application);
  saveApplications();
  displayApplications();

  alert("Job saved to tracker.");
}

loadApplications();