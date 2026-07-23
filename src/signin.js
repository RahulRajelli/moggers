import "./style.css";

/* The callback deliberately reports only `failed` — distinguishing a CSRF
   rejection from a misconfigured provider would tell an attacker which one they
   hit. Map the two coarse codes to something a human can act on. */
const MESSAGES = {
  failed: "Sign-in did not complete. Please try again.",
  unconfigured: "That provider is not set up on this deployment yet.",
};

const params = new URLSearchParams(location.search);
const error = params.get("error");

if (error) {
  const box = document.getElementById("err");
  box.textContent = MESSAGES[error] ?? MESSAGES.failed;
  box.hidden = false;
}
