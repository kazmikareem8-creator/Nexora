const navButtons=document.querySelectorAll("[data-view]");
const pageTitle=document.getElementById("pageTitle");
const pageSubtitle=document.getElementById("pageSubtitle");
const welcomeRow=document.querySelector(".welcome-row");
const dialog=document.getElementById("projectDialog");
const form=document.getElementById("projectForm");
const projectNameInput=document.getElementById("projectName");
const projectList=document.getElementById("projectList");
const emptyProjects=document.getElementById("emptyProjects");
const heroProjectCount=document.getElementById("heroProjectCount");
const notice=document.querySelector(".notice");
const sectionHeading=document.querySelector(".section-heading");
const contentGrid=document.querySelector(".content-grid");
const footer=document.querySelector("footer");
const viewCopy={
 overview:["Welcome to<br><span>Nexora</span><i class='typing-cursor'></i>","Access powerful AI models, manage your API keys, and bring your ideas to life — all in one place."],
 dashboard:["Your dashboard.","Your Nexora workspace at a glance."],
 projects:["Your projects.","Organise the apps and integrations you plan to connect."],
 "api-keys":["Your API keys.","Manage secure credentials for your applications."],
 docs:["Build with Nexora.","Developer documentation and integration examples."],
 settings:["Workspace settings.","Manage your Nexora workspace preferences."],
 usage:["Your usage.","Usage analytics will appear after the API gateway is connected."],
 logs:["Request logs.","Inspect API activity after the gateway is implemented."],
 models:["Explore models.","Model discovery and routing are planned for a later milestone."]
};
const descriptions={
 dashboard:["Workspace dashboard","Your overview is being expanded as Nexora's account and API services are built."],
 projects:["Project workspaces","Create and organise projects here. Project saving is currently a browser-only preview."],
 "api-keys":["API key management","Nexora will generate and manage its own API credentials. No real keys are generated in this preview."],
 docs:["Nexora developer guide","The unified API format, authentication instructions and copy-ready code examples will be added after the gateway is built."],
 settings:["Settings are coming","Account profiles, preferences and workspace controls will be added in a later milestone."],
 usage:["Usage analytics","Live request counts and token usage will appear after the gateway and usage database are connected."],
 logs:["Activity logs","Request-level logs will be available after the API gateway is implemented."],
 models:["Model directory","Nexora will list providers and models that are actually configured and available. No model connections are active yet."]
};
let projects=[];
let activeView="overview";
function openProjectDialog(){projectNameInput.value="";dialog.showModal();projectNameInput.focus();}
document.getElementById("newProjectButton").addEventListener("click",openProjectDialog);
document.getElementById("emptyCreateButton").addEventListener("click",openProjectDialog);
form.addEventListener("submit",event=>{event.preventDefault();const name=projectNameInput.value.trim();if(!name)return;projects.push({id:Date.now(),name});renderProjects();dialog.close();});
function renderProjects(){
 heroProjectCount.textContent=String(projects.length);
 emptyProjects.hidden=projects.length>0;
 projectList.innerHTML="";
 projects.forEach(project=>{
  const row=document.createElement("div");row.className="project-row";
  const symbol=document.createElement("span");symbol.className="project-symbol";symbol.textContent="▦";
  const details=document.createElement("div");const title=document.createElement("strong");title.textContent=project.name;
  const subtitle=document.createElement("small");subtitle.textContent="Local preview project";details.append(title,subtitle);
  const state=document.createElement("span");state.className="project-state";state.textContent="PREVIEW";
  row.append(symbol,details,state);projectList.append(row);
 });
}
function setView(view){
 if(!viewCopy[view])return;activeView=view;
 navButtons.forEach(button=>button.classList.toggle("active",button.dataset.view===view));
 const isHome=view==="overview";
 pageTitle.innerHTML=viewCopy[view][0];pageSubtitle.textContent=viewCopy[view][1];
 notice.hidden=!isHome;sectionHeading.hidden=!isHome;contentGrid.hidden=!isHome;
 let placeholder=document.getElementById("viewPlaceholder");
 if(isHome){if(placeholder)placeholder.remove();return;}
 if(!placeholder){placeholder=document.createElement("section");placeholder.id="viewPlaceholder";placeholder.className="view-placeholder";welcomeRow.after(placeholder);}
 const [heading,description]=descriptions[view];placeholder.replaceChildren();
 const wrap=document.createElement("div");const title=document.createElement("h2");title.textContent=heading;
 const paragraph=document.createElement("p");paragraph.textContent=description;
 const badge=document.createElement("span");badge.className="bottom-badge";badge.textContent="PLANNED MILESTONE";
 wrap.append(title,paragraph,badge);placeholder.append(wrap);
}
navButtons.forEach(button=>button.addEventListener("click",()=>setView(button.dataset.view)));
document.getElementById("menuButton").addEventListener("click",()=>document.getElementById("sidebar").classList.toggle("open"));
document.querySelectorAll(".sidebar .nav-item").forEach(button=>button.addEventListener("click",()=>document.getElementById("sidebar").classList.remove("open")));
fetch("/api/health").then(response=>{if(!response.ok)throw new Error("Health check failed");return response.json();}).then(data=>{if(data.status!=="online")throw new Error("Server is not online");document.querySelectorAll(".footer-status").forEach(status=>status.lastChild.textContent=" Website online");}).catch(()=>{document.querySelectorAll(".footer-status").forEach(status=>status.lastChild.textContent=" Connection unavailable");});
renderProjects();