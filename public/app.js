(() => {
const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
const nav=$$("[data-view]"),title=$("#pageTitle"),subtitle=$("#pageSubtitle"),welcome=$(".welcome-row"),notice=$(".notice"),section=$(".section-heading"),grid=$(".content-grid"),dialog=$("#projectDialog"),form=$("#projectForm"),nameInput=$("#projectName");
let projects=[];try{projects=JSON.parse(localStorage.getItem("nexora-projects")||"[]");if(!Array.isArray(projects))projects=[];}catch{}
let settings={displayName:"Creator",workspaceName:"My workspace"};try{settings={...settings,...JSON.parse(localStorage.getItem("nexora-settings")||"{}")};}catch{}
let currentView="overview",activeProject=null;
function syncProfile(){$(".creator-head strong").textContent="Hello, "+settings.displayName+"!";$(".plan-card strong").textContent=settings.workspaceName;$("#profileButton").textContent=(settings.displayName||"C").trim().charAt(0).toUpperCase();}
function persistProjects(){try{localStorage.setItem("nexora-projects",JSON.stringify(projects));}catch{}}
function renderProjects(){
 $("#heroProjectCount").textContent=projects.length;$("#projectList").replaceChildren();$("#emptyProjects").hidden=projects.length>0;
 projects.forEach(p=>{const b=document.createElement("button");b.type="button";b.className="project-row project-open";b.innerHTML="<span class='project-symbol'>▦</span><span class='project-details'><strong></strong><small>Open project workspace</small></span><span class='project-state'>OPEN →</span>";b.querySelector("strong").textContent=p.name;b.addEventListener("click",()=>openProject(p.id));$("#projectList").append(b);});
}
function showContent(node){let old=$("#viewPlaceholder");if(!old){old=document.createElement("section");old.id="viewPlaceholder";welcome.after(old);}old.className="view-placeholder";old.replaceChildren(node);}
function make(tag,cls,txt){const e=document.createElement(tag);if(cls)e.className=cls;if(txt!==undefined)e.textContent=txt;return e;}
function panel(titleText,description){const box=make("div","page-card");box.append(make("h2","",titleText),make("p","",description));return box;}
function openProject(id){activeProject=projects.find(p=>p.id===id);if(!activeProject)return;currentView="project-detail";nav.forEach(b=>b.classList.remove("active"));title.innerHTML="Project<br><span>Workspace</span>";subtitle.textContent=activeProject.name;notice.hidden=true;section.hidden=true;grid.hidden=true;const box=panel(activeProject.name,"This is your project workspace. API keys and live model connections will be added in upcoming milestones.");box.append(make("div","project-meta","Created in this browser · Local preview"));const back=make("button","secondary-button","← Back to projects");back.addEventListener("click",()=>setView("projects"));const rename=make("button","secondary-button","Rename project");rename.addEventListener("click",()=>{const next=prompt("New project name",activeProject.name);if(next&&next.trim()){activeProject.name=next.trim().slice(0,40);persistProjects();renderProjects();openProject(id);}});const remove=make("button","secondary-button","Delete project");remove.addEventListener("click",()=>{if(confirm("Delete "+activeProject.name+"?")){projects=projects.filter(p=>p.id!==id);persistProjects();renderProjects();setView("projects");}});const actions=make("div","settings-actions");actions.append(back,rename,remove);box.append(actions);showContent(box);}
function renderSettings(){const box=panel("Workspace settings","These preferences are saved on this device.");const f=make("form","settings-form");f.innerHTML="<label for='displayNameSetting'>Display name</label><input id='displayNameSetting' maxlength='32'><label for='workspaceNameSetting'>Workspace name</label><input id='workspaceNameSetting' maxlength='40'><div class='settings-actions'><button class='primary-button' type='submit'>Save preferences</button><button class='secondary-button' id='resetSettings' type='button'>Reset</button></div><p class='settings-feedback' id='settingsFeedback' role='status'></p>";box.append(f);f.elements.displayNameSetting.value=settings.displayName;f.elements.workspaceNameSetting.value=settings.workspaceName;f.addEventListener("submit",e=>{e.preventDefault();settings={displayName:f.elements.displayNameSetting.value.trim()||"Creator",workspaceName:f.elements.workspaceNameSetting.value.trim()||"My workspace"};try{localStorage.setItem("nexora-settings",JSON.stringify(settings));}catch{}syncProfile();$("#settingsFeedback").textContent="Saved on this device."});$("#resetSettings").addEventListener("click",()=>{settings={displayName:"Creator",workspaceName:"My workspace"};try{localStorage.removeItem("nexora-settings");}catch{}syncProfile();renderSettings();});showContent(box);}
function renderProjectsPage(){const box=panel("Your projects","Create, open, rename or delete your browser-saved project workspaces.");const create=make("button","primary-button","＋ Create project");create.addEventListener("click",openDialog);box.append(create);const list=make("div","project-page-list");if(!projects.length)list.append(make("p","doc-copy","No projects yet. Create your first project to get started."));projects.forEach(p=>{const row=make("div","project-page-row");row.append(make("span","project-symbol","▦"),make("strong","",p.name));const open=make("button","secondary-button","Open");open.addEventListener("click",()=>openProject(p.id));row.append(open);list.append(row);});box.append(list);showContent(box);}
function setView(view){currentView=view;nav.forEach(b=>b.classList.toggle("active",b.dataset.view===view));const home=view==="overview";title.innerHTML=home?"Welcome to<br><span>Nexora</span><i class='typing-cursor'></i>":({dashboard:"Your dashboard.",projects:"Your projects.",settings:"Workspace settings.","api-keys":"Your API keys."}[view]||"Nexora");subtitle.textContent=home?"Access powerful AI models, manage your API keys, and bring your ideas to life — all in one place.":({dashboard:"Your Nexora workspace at a glance.",projects:"Manage and open your projects.",settings:"Manage your workspace preferences.","api-keys":"API key management is coming in Day 3."}[view]||"");notice.hidden=!home;section.hidden=!home;grid.hidden=!home;const old=$("#viewPlaceholder");if(home){old?.remove();return;}if(view==="projects")renderProjectsPage();else if(view==="settings")renderSettings();else{const box=panel(view==="api-keys"?"API key management":"Dashboard overview",view==="api-keys"?"Secure API key generation is scheduled for Day 3. No fake keys are shown.":"Account-backed usage and activity will appear after authentication and database setup.");showContent(box);}}
function openDialog(){nameInput.value="";dialog.showModal();nameInput.focus();}
$("#newProjectButton").addEventListener("click",openDialog);$("#emptyCreateButton").addEventListener("click",openDialog);
form.addEventListener("submit",e=>{e.preventDefault();const name=nameInput.value.trim();if(!name)return;projects.push({id:Date.now(),name:name.slice(0,40)});persistProjects();renderProjects();dialog.close();});
nav.forEach(b=>b.addEventListener("click",()=>{if(b.dataset.view)setView(b.dataset.view);$("#sidebar").classList.remove("open");}));
$(".quick-link").forEach(b=>b.addEventListener("click",()=>setView(b.dataset.view)));
$("#menuButton").addEventListener("click",()=>$("#sidebar").classList.toggle("open"));
$("#profileButton").addEventListener("click",()=>setView("settings"));$("#notificationButton").addEventListener("click",()=>alert("You're all caught up. Nexora notifications will appear here."));
const search=$(".search-box input");
const searchResults=make("div","search-results");searchResults.hidden=true;$(".search-box").append(searchResults);
const searchItems=[
 {name:"Home",hint:"Main workspace",view:"overview",terms:"home overview start"},
 {name:"Dashboard",hint:"Usage and activity",view:"dashboard",terms:"dashboard usage analytics activity stats"},
 {name:"API Keys",hint:"Create and manage keys",view:"api-keys",terms:"api key keys token generate credentials"},
 {name:"Projects",hint:"Your project workspaces",view:"projects",terms:"project projects workspace app"},
 {name:"Settings",hint:"Workspace preferences",view:"settings",terms:"settings preferences profile account"}
];
function runSearch(){
 const q=search.value.trim().toLowerCase();searchResults.replaceChildren();
 if(!q){searchResults.hidden=true;return;}
 const matches=[];
 searchItems.forEach(item=>{if((item.name+" "+item.hint+" "+item.terms).toLowerCase().includes(q)||q.split(/\\s+/).some(word=>item.terms.includes(word)))matches.push({label:item.name,hint:item.hint,action:()=>setView(item.view)});});
 projects.filter(p=>p.name.toLowerCase().includes(q)).forEach(p=>matches.push({label:p.name,hint:"Open project",action:()=>openProject(p.id)}));
 if(!matches.length)searchResults.append(make("div","search-empty","No results found. Try “projects”, “API keys” or “settings”."));
 matches.slice(0,8).forEach(item=>{const b=make("button","search-result");b.type="button";b.append(make("strong","",item.label),make("small","",item.hint));b.addEventListener("click",()=>{item.action();searchResults.hidden=true;search.value="";});searchResults.append(b);});
 searchResults.hidden=false;
}
search.addEventListener("input",runSearch);
search.addEventListener("keydown",e=>{if(e.key==="Enter"){e.preventDefault();const first=searchResults.querySelector(".search-result");if(first)first.click();}if(e.key==="Escape")searchResults.hidden=true;});
document.addEventListener("click",e=>{if(!$(".search-box").contains(e.target))searchResults.hidden=true;});
$("#sidebar .brand").addEventListener("click",e=>{e.preventDefault();setView("overview");});
syncProfile();renderProjects();
fetch("/api/health").then(r=>{if(!r.ok)throw Error();return r.json();}).then(d=>{if(d.status!=="online")throw Error();$(".footer-status").lastChild.textContent=" Website online";}).catch(()=>{$(".footer-status").lastChild.textContent=" Connection unavailable";});
})();