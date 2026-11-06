const navButtons = document.querySelectorAll("[data-view]");
const pageTitle = document.getElementById("pageTitle");
const pageSubtitle = document.getElementById("pageSubtitle");
const crumbTitle = document.getElementById("crumbTitle");
const pageContent = document.querySelector(".page-wrap");
const dialog = document.getElementById("projectDialog");
const form = document.getElementById("projectForm");
const projectNameInput = document.getElementById("projectName");
const projectList = document.getElementById("projectList");
const emptyProjects = document.getElementById("emptyProjects");
const projectCount = document.getElementById("projectCount");
const welcomeRow = document.querySelector(".welcome-row");
const notice = document.querySelector(".notice");
const sectionHeading = document.querySelector(".section-heading");
const statsGrid = document.querySelector(".stats-grid");
const contentGrid = document.querySelector(".content-grid");
const bottomPanel = document.querySelector(".bottom-panel");

const viewCopy = {
  overview: ["Build with intelligence.", "One place to manage your AI projects, keys and usage."],
  projects: ["Your projects.", "Organise the apps and integrations you plan to connect."],
  "api-keys": ["Your API keys.", "Secure Nexora credentials will be managed here."],
  usage: ["Understand your usage.", "Track requests and token consumption across projects."],
  logs: ["Request logs.", "Inspect API activity and troubleshoot integrations."],
  models: ["Explore models.", "Model discovery and routing are planned for a later milestone."],
  docs: ["Build with Nexora.", "Developer documentation and integration examples."]
};

const placeholderCopy = {
  projects: ["Project workspaces", "Create and organise projects here. Project saving is currently a browser-only preview and will become account-backed in a later milestone."],
  "api-keys": ["API key management", "Nexora will generate and manage its own API credentials. No real keys are generated in this Day 1 preview."],
  usage: ["Usage analytics", "Live request counts, token usage and provider costs will appear after the gateway and usage database are connected."],
  logs: ["Activity logs", "Request-level logs will be available after the API gateway is implemented."],
  models: ["Model directory", "Nexora will list providers and models that are actually configured and available. No model connections are active yet."],
  docs: ["Nexora developer guide", "The unified API format, authentication instructions and copy-ready code examples will be added after the gateway is built."]
};

let projects = [];
let activeView = "overview";

function openProjectDialog() {
  projectNameInput.value = "";
  dialog.showModal();
  projectNameInput.focus();
}

document.getElementById("newProjectButton").addEventListener("click", openProjectDialog);
document.getElementById("emptyCreateButton").addEventListener("click", openProjectDialog);

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const name = projectNameInput.value.trim();
  if (!name) return;
  projects.push({ id: Date.now(), name });
  renderProjects();
  dialog.close();
});

function renderProjects() {
  projectCount.textContent = String(projects.length);
  emptyProjects.hidden = projects.length > 0;
  projectList.innerHTML = "";
  projects.forEach((project) => {
    const row = document.createElement("div");
    row.className = "project-row";
    const symbol = document.createElement("span");
    symbol.className = "project-symbol";
    symbol.textContent = "▦";
    const details = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = project.name;
    const subtitle = document.createElement("small");
    subtitle.textContent = "Local preview project";
    details.append(title, subtitle);
    const state = document.createElement("span");
    state.className = "project-state";
    state.textContent = "PREVIEW";
    row.append(symbol, details, state);
    projectList.append(row);
  });
}

function setView(view) {
  if (!viewCopy[view]) return;
  activeView = view;
  navButtons.forEach((button) => button.classList.toggle("active", button.dataset.view === view));
  crumbTitle.textContent = view === "api-keys" ? "API keys" : view.charAt(0).toUpperCase() + view.slice(1);
  pageTitle.innerHTML = view === "overview" ? 'Build with <span>intelligence.</span>' : viewCopy[view][0];
  pageSubtitle.textContent = viewCopy[view][1];

  const isOverview = view === "overview";
  notice.hidden = !isOverview;
  sectionHeading.hidden = !isOverview;
  statsGrid.hidden = !isOverview;
  contentGrid.hidden = !isOverview;
  bottomPanel.hidden = !isOverview;
  let placeholder = document.getElementById("viewPlaceholder");
  if (isOverview) {
    if (placeholder) placeholder.remove();
    return;
  }
  if (!placeholder) {
    placeholder = document.createElement("section");
    placeholder.id = "viewPlaceholder";
    placeholder.className = "view-placeholder";
    welcomeRow.after(placeholder);
  }
  const [heading, description] = placeholderCopy[view];
  placeholder.innerHTML = "";
  const wrap = document.createElement("div");
  const title = document.createElement("h2");
  title.textContent = heading;
  const paragraph = document.createElement("p");
  paragraph.textContent = description;
  const note = document.createElement("span");
  note.className = "bottom-badge";
  note.textContent = "PLANNED MILESTONE";
  wrap.append(title, paragraph, note);
  placeholder.append(wrap);
}

navButtons.forEach((button) => button.addEventListener("click", () => setView(button.dataset.view)));
document.getElementById("menuButton").addEventListener("click", () => {
  document.getElementById("sidebar").classList.toggle("open");
});

document.querySelectorAll(".sidebar .nav-item").forEach((button) => {
  button.addEventListener("click", () => document.getElementById("sidebar").classList.remove("open"));
});

fetch("/api/health")
  .then((response) => {
    if (!response.ok) throw new Error("Health check failed");
    return response.json();
  })
  .then((data) => {
    if (data.status !== "online") throw new Error("Server is not online");
    document.querySelectorAll(".footer-status").forEach((status) => {
      status.lastChild.textContent = " Website online";
    });
  })
  .catch(() => {
    document.querySelectorAll(".footer-status").forEach((status) => {
      status.lastChild.textContent = " Connection unavailable";
    });
  });

renderProjects();
