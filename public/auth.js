(() => {
  const topbar = document.querySelector(".topbar-right");
  if (!topbar) return;

  const accountButton = document.createElement("button");
  accountButton.type = "button";
  accountButton.className = "account-button";
  accountButton.textContent = "Sign in";
  accountButton.setAttribute("aria-label", "Sign in or view account");
  topbar.insertBefore(accountButton, topbar.firstChild);

  const dialog = document.createElement("dialog");
  dialog.className = "auth-dialog";
  dialog.innerHTML = `
    <form class="auth-card" id="authForm">
      <div class="auth-top"><span class="dialog-mark">N</span><button class="close-button" type="button" id="authClose" aria-label="Close">×</button></div>
      <p class="eyebrow">NEXORA ACCOUNT</p>
      <h2 id="authTitle">Welcome back</h2>
      <p class="auth-description" id="authDescription">Sign in to your Nexora workspace.</p>
      <div class="auth-switch"><button type="button" class="auth-tab active" id="loginTab">Sign in</button><button type="button" class="auth-tab" id="registerTab">Create account</button></div>
      <div id="displayNameField" hidden><label for="authName">Display name</label><input id="authName" maxlength="40" autocomplete="nickname" placeholder="Your name"></div>
      <label for="authEmail">Email address</label><input id="authEmail" type="email" maxlength="254" autocomplete="email" required value="kazmikareem8@gmail.com" placeholder="you@example.com">
      <label for="authPassword">Password</label><input id="authPassword" type="password" minlength="10" maxlength="72" autocomplete="current-password" required placeholder="At least 10 characters">
      <p class="auth-message" id="authMessage" role="status" aria-live="polite"></p>
      <button class="primary-button auth-submit" id="authSubmit" type="submit">Sign in →</button>
      <p class="auth-footnote">Your password is securely hashed. Never share it with anyone.</p>
    </form>
    <div class="auth-account" id="authAccount" hidden>
      <div class="auth-top"><span class="dialog-mark">N</span><button class="close-button" type="button" id="accountClose" aria-label="Close">×</button></div>
      <p class="eyebrow">YOUR ACCOUNT</p><h2 id="accountName">Creator</h2><p class="auth-description" id="accountEmail"></p>
      <p class="auth-message">You're signed in to Nexora.</p>
      <button class="secondary-button auth-submit" type="button" id="signOutButton">Sign out</button>
    </div>`;
  document.body.append(dialog);

  const form = dialog.querySelector("#authForm");
  const account = dialog.querySelector("#authAccount");
  const loginTab = dialog.querySelector("#loginTab");
  const registerTab = dialog.querySelector("#registerTab");
  const nameField = dialog.querySelector("#displayNameField");
  const password = dialog.querySelector("#authPassword");
  const message = dialog.querySelector("#authMessage");
  let mode = "login";
  let user = null;

  function setMessage(text, isError = true) {
    message.textContent = text;
    message.classList.toggle("error", isError);
    message.classList.toggle("success", !isError);
  }
  function setMode(next) {
    mode = next;
    const registering = mode === "register";
    loginTab.classList.toggle("active", !registering);
    registerTab.classList.toggle("active", registering);
    nameField.hidden = !registering;
    password.autocomplete = registering ? "new-password" : "current-password";
    password.minLength = registering ? 10 : 1;
    dialog.querySelector("#authTitle").textContent = registering ? "Create your account" : "Welcome back";
    dialog.querySelector("#authDescription").textContent = registering ? "Create a Nexora account to get started." : "Sign in to your Nexora workspace.";
    dialog.querySelector("#authSubmit").textContent = registering ? "Create account →" : "Sign in →";
    setMessage("");
  }
  function renderUser(nextUser) {
    user = nextUser;
    if (user) {
      accountButton.textContent = user.displayName || "Account";
      accountButton.setAttribute("aria-label", "Open account menu");
      dialog.querySelector("#accountName").textContent = user.displayName || "Creator";
      dialog.querySelector("#accountEmail").textContent = user.email;
      form.hidden = true;
      account.hidden = false;
    } else {
      accountButton.textContent = "Sign in";
      accountButton.setAttribute("aria-label", "Sign in");
      form.hidden = false;
      account.hidden = true;
    }
  }

  accountButton.addEventListener("click", () => {
    if (user) {
      renderUser(user);
      dialog.showModal();
    } else {
      setMode("login");
      renderUser(null);
      dialog.showModal();
    }
  });
  loginTab.addEventListener("click", () => setMode("login"));
  registerTab.addEventListener("click", () => setMode("register"));
  dialog.querySelector("#authClose").addEventListener("click", () => dialog.close());
  dialog.querySelector("#accountClose").addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", event => {
    if (event.target === dialog) dialog.close();
  });

  form.addEventListener("submit", async event => {
    event.preventDefault();
    const submit = dialog.querySelector("#authSubmit");
    submit.disabled = true;
    submit.textContent = mode === "register" ? "Creating account…" : "Signing in…";
    setMessage("");
    const body = {
      email: dialog.querySelector("#authEmail").value.trim(),
      password: password.value,
      displayName: dialog.querySelector("#authName").value.trim()
    };
    try {
      const response = await fetch("/api/auth/" + mode, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(body)
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Request failed.");
      renderUser(data.user);
      dialog.close();
      password.value = "";
      try {
        const saved = JSON.parse(localStorage.getItem("nexora-settings") || "{}");
        saved.displayName = data.user.displayName || "Creator";
        localStorage.setItem("nexora-settings", JSON.stringify(saved));
      } catch {}
      const profile = document.querySelector("#profileButton");
      if (profile) profile.textContent = (data.user.displayName || "C").charAt(0).toUpperCase();
    } catch (error) {
      setMessage(error.message || "Could not connect. Please try again.");
    } finally {
      submit.disabled = false;
      submit.textContent = mode === "register" ? "Create account →" : "Sign in →";
    }
  });

  dialog.querySelector("#signOutButton").addEventListener("click", async () => {
    const button = dialog.querySelector("#signOutButton");
    button.disabled = true;
    try {
      const response = await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Sign out failed.");
      renderUser(null);
      dialog.close();
    } catch (error) {
      dialog.querySelector("#accountEmail").textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });

  fetch("/api/auth/me", { credentials: "same-origin" })
    .then(response => response.json().then(data => ({ response, data })))
    .then(({ response, data }) => {
      if (response.ok) renderUser(data.user);
      else accountButton.title = data.error || "Account service unavailable";
    })
    .catch(() => { accountButton.title = "Could not check account status"; });
})();