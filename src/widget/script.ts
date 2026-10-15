/**
 * The embeddable website widget (FEATURES §21, IMPLEMENTATION_PLAN step 18).
 *
 * Served by GET /widget.js. A business pastes one snippet on its site:
 *
 *   <script src="https://API_HOST/widget.js" data-business="BUSINESS_ID" async></script>
 *
 * Design constraints, on purpose:
 * - zero dependencies, plain ES5-flavoured JS: it must run on any site
 *   (old WordPress, plain HTML, anything) without a build step;
 * - no cookies, no localStorage, no third-party anything: it only POSTs
 *   the form to our API, so GDPR surface stays minimal;
 * - DOM built with createElement + textContent only (no innerHTML with
 *   data), so a hostile message string can never inject markup;
 * - data-api overrides the API origin for split deployments; by default
 *   the script assumes it is served by the API itself (same origin).
 */
export const WIDGET_SCRIPT = `(function () {
  "use strict";
  var script = document.currentScript;
  if (!script) return;

  var businessId = script.getAttribute("data-business");
  if (!businessId) return;

  var api = (script.getAttribute("data-api") || (script.src ? new URL(script.src).origin : "")).replace(/\\/+$/, "");
  if (!api) return;
  var endpoint = api + "/api/v1/leads/public/" + encodeURIComponent(businessId);

  var CSS = [
    ".ldz-btn{position:fixed;right:20px;bottom:20px;z-index:2147483000;padding:12px 20px;border:0;border-radius:9999px;background:#171717;color:#fff;font:600 14px/1 system-ui,-apple-system,sans-serif;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.25)}",
    ".ldz-btn:hover{opacity:.9}",
    ".ldz-panel{position:fixed;right:20px;bottom:76px;z-index:2147483000;width:320px;max-width:calc(100vw - 40px);background:#fff;color:#171717;border:1px solid #e5e5e5;border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.18);font:14px/1.45 system-ui,-apple-system,sans-serif;display:none}",
    ".ldz-panel.ldz-open{display:block}",
    ".ldz-head{padding:14px 16px 0;font-weight:700;font-size:15px}",
    ".ldz-sub{padding:4px 16px 0;color:#525252;font-size:12.5px}",
    ".ldz-form{padding:12px 16px 16px;display:flex;flex-direction:column;gap:8px}",
    ".ldz-form input,.ldz-form textarea{width:100%;box-sizing:border-box;padding:9px 10px;border:1px solid #d4d4d4;border-radius:8px;font:14px/1.3 system-ui,-apple-system,sans-serif;color:#171717;background:#fff}",
    ".ldz-form input:focus,.ldz-form textarea:focus{outline:2px solid #171717;outline-offset:1px;border-color:#171717}",
    ".ldz-form textarea{min-height:74px;resize:vertical}",
    ".ldz-hp{position:absolute!important;left:-9999px!important;top:auto!important;width:1px!important;height:1px!important;overflow:hidden!important}",
    ".ldz-submit{margin-top:2px;padding:10px 12px;border:0;border-radius:8px;background:#171717;color:#fff;font:600 14px/1 system-ui,-apple-system,sans-serif;cursor:pointer}",
    ".ldz-submit:disabled{opacity:.6;cursor:default}",
    ".ldz-error{display:none;padding:8px 10px;border-radius:8px;background:#fef2f2;color:#991b1b;font-size:12.5px}",
    ".ldz-done{display:none;padding:26px 16px 28px;text-align:center;color:#171717}",
    ".ldz-done strong{display:block;font-size:15px;margin-bottom:6px}",
    ".ldz-done span{color:#525252;font-size:13px}",
  ].join("");

  function el(tag, attrs, parent) {
    var node = document.createElement(tag);
    for (var key in attrs) node.setAttribute(key, attrs[key]);
    if (parent) parent.appendChild(node);
    return node;
  }

  var style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);

  var button = el("button", { type: "button", class: "ldz-btn", "aria-label": "Send an enquiry" }, document.body);
  button.textContent = "Send an enquiry";

  var panel = el("div", { class: "ldz-panel", role: "dialog", "aria-label": "Enquiry form" }, document.body);
  var heading = el("div", { class: "ldz-head" }, panel);
  heading.textContent = "How can we help?";
  var sub = el("div", { class: "ldz-sub" }, panel);
  sub.textContent = "Send a message and we will get back to you.";

  var errorBox = el("div", { class: "ldz-error", role: "alert" }, panel);

  var form = el("form", { class: "ldz-form", novalidate: "novalidate" }, panel);
  el("input", { name: "name", type: "text", placeholder: "Your name *", required: "required", autocomplete: "name", maxlength: "120" }, form);
  el("input", { name: "phone", type: "tel", placeholder: "Phone", autocomplete: "tel", maxlength: "30" }, form);
  el("input", { name: "email", type: "email", placeholder: "Email", autocomplete: "email", maxlength: "254" }, form);
  el("input", { name: "serviceName", type: "text", placeholder: "Service needed (optional)", maxlength: "120" }, form);
  el("input", { name: "postcode", type: "text", placeholder: "Postcode", autocomplete: "postal-code", maxlength: "12" }, form);
  el("textarea", { name: "message", placeholder: "What do you need help with? *", required: "required", maxlength: "4000" }, form);
  // Honeypot: invisible to people, tempting to bots (see backend).
  el("input", { class: "ldz-hp", name: "website", type: "text", tabindex: "-1", autocomplete: "off", "aria-hidden": "true" }, form);

  var submit = el("button", { type: "submit", class: "ldz-submit" }, form);
  submit.textContent = "Send enquiry";

  var done = el("div", { class: "ldz-done" }, panel);
  var doneTitle = el("strong", {}, done);
  doneTitle.textContent = "Thanks — message sent!";
  var doneSub = el("span", {}, done);
  doneSub.textContent = "We will be in touch as soon as we can.";

  function toggle(open) {
    panel.classList.toggle("ldz-open", open);
  }
  button.addEventListener("click", function () {
    toggle(!panel.classList.contains("ldz-open"));
    if (panel.classList.contains("ldz-open")) {
      var first = form.querySelector("input[name=name]");
      if (first) first.focus();
    }
  });

  function showError(text) {
    errorBox.textContent = text;
    errorBox.style.display = "block";
  }
  function clearError() {
    errorBox.style.display = "none";
  }

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    clearError();

    var data = {};
    var fields = ["name", "phone", "email", "serviceName", "postcode", "message", "website"];
    for (var i = 0; i < fields.length; i++) {
      var input = form.querySelector("[name=" + fields[i] + "]");
      var value = input && input.value ? input.value.trim() : "";
      if (value) data[fields[i]] = value;
    }
    if (!data.name) { showError("Please enter your name."); return; }
    if (!data.message) { showError("Please describe what you need help with."); return; }
    if (!data.phone && !data.email) { showError("Add a phone number or email so we can reply."); return; }

    submit.disabled = true;
    submit.textContent = "Sending…";

    fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(data),
    })
      .then(function (response) {
        return response
          .json()
          .catch(function () { return null; })
          .then(function (payload) { return { status: response.status, payload: payload }; });
      })
      .then(function (result) {
        if (result.status === 200 || result.status === 201) {
          form.style.display = "none";
          done.style.display = "block";
          return;
        }
        var message = "Sorry, something went wrong. Please try again.";
        if (result.payload && result.payload.success === false && result.payload.error && result.payload.error.message) {
          message = result.payload.error.message;
        }
        showError(message);
      })
      .catch(function () {
        showError("We could not reach the server. Check your connection and try again.");
      })
      .then(function () {
        submit.disabled = false;
        submit.textContent = "Send enquiry";
      });
  });
})();
`;
