const loginForm = document.getElementById("loginForm");
const passwordInput = document.getElementById("password");
const loginBtn = document.getElementById("loginBtn");
const message = document.getElementById("message");

const setMessage = (text, type) => {
  message.textContent = text;
  message.classList.remove("ok", "error");
  if (type) message.classList.add(type);
};

loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const pwd = passwordInput.value;
  setMessage("", "");
  loginBtn.disabled = true;
  loginBtn.textContent = "Signing in...";

  try {
    const res = await fetch("/login", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ password: pwd })
    });

    if (res.ok) {
      setMessage("Login successful. Redirecting...", "ok");
      setTimeout(() => {
        window.location.href = "chat.html";
      }, 500);
      return;
    }

    let errorText = "Login failed";
    try {
      const data = await res.json();
      errorText = data.message || errorText;
    } catch (parseErr) {}
    setMessage(errorText, "error");
  } catch (err) {
    setMessage(`Error: ${err.message}`, "error");
  } finally {
    loginBtn.disabled = false;
    loginBtn.textContent = "Continue to Chat";
  }
});
