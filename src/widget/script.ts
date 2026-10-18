/**
 * The embeddable website widget (FEATURES §21, §22; IMPLEMENTATION_PLAN steps
 * 18–19).
 *
 * Served by GET /widget.js. A business pastes one snippet on their site:
 *
 *   <script src="https://API_HOST/widget.js" data-business="BUSINESS_ID" async></script>
 *
 * The widget asks the backend whether the AI is available:
 * - AI on  → the visitor first shares a few details (name + phone or email +
 *   what they need, plus optional service / urgency / preferred date), which
 *   starts the chat thread. Those details become the customer/lead record, so
 *   a chat always leaves the business something it can act on, and the AI
 *   continues qualifying inside the thread (§22);
 * - AI off, or the chat endpoint failing → the plain enquiry form, so the
 *   business never loses a lead to a dead chat (§22).
 *
 * Design constraints, on purpose:
 * - zero dependencies, plain ES5-flavoured JS: it must run on any site
 *   (old WordPress, plain HTML, anything) without a build step;
 * - no cookies, no localStorage, no third-party anything: the chat thread
 *   token lives in a JS variable, so a page reload simply starts a fresh
 *   thread — no persistent identifier, minimal GDPR surface;
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
  var leadEndpoint = api + "/api/v1/leads/public/" + encodeURIComponent(businessId);
  var chatBase = api + "/api/v1/chat/public/" + encodeURIComponent(businessId);

  var CSS = [
    ".ldz-btn{position:fixed;right:20px;bottom:20px;z-index:2147483000;padding:12px 20px;border:0;border-radius:9999px;background:#171717;color:#fff;font:600 14px/1 system-ui,-apple-system,sans-serif;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.25)}",
    ".ldz-btn:hover{opacity:.9}",
    ".ldz-panel{position:fixed;right:20px;bottom:76px;z-index:2147483000;width:340px;max-width:calc(100vw - 40px);background:#fff;color:#171717;border:1px solid #e5e5e5;border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.18);font:14px/1.45 system-ui,-apple-system,sans-serif;display:none;overflow:hidden}",
    ".ldz-panel.ldz-open{display:block}",
    ".ldz-head{padding:14px 16px 0;font-weight:700;font-size:15px}",
    ".ldz-sub{padding:4px 16px 0;color:#525252;font-size:12.5px}",
    ".ldz-msgs{display:flex;flex-direction:column;gap:8px;padding:14px 16px;max-height:280px;min-height:120px;overflow-y:auto;background:#fafafa}",
    ".ldz-empty{color:#737373;font-size:13px}",
    ".ldz-msg{max-width:82%;padding:8px 11px;border-radius:12px;font-size:13.5px;line-height:1.4;white-space:pre-wrap;word-wrap:break-word;overflow-wrap:anywhere}",
    ".ldz-msg-customer{align-self:flex-end;background:#171717;color:#fff;border-bottom-right-radius:4px}",
    ".ldz-msg-agent{align-self:flex-start;background:#e5e5e5;color:#171717;border-bottom-left-radius:4px}",
    ".ldz-typing{color:#525252;font-style:italic}",
    ".ldz-compose{display:flex;gap:8px;padding:12px 16px 4px}",
    ".ldz-compose input{flex:1;min-width:0;box-sizing:border-box;padding:9px 10px;border:1px solid #d4d4d4;border-radius:8px;font:14px/1.3 system-ui,-apple-system,sans-serif;color:#171717;background:#fff}",
    ".ldz-compose input:focus{outline:2px solid #171717;outline-offset:1px;border-color:#171717}",
    ".ldz-send{padding:9px 14px;border:0;border-radius:8px;background:#171717;color:#fff;font:600 14px/1 system-ui,-apple-system,sans-serif;cursor:pointer}",
    ".ldz-send:disabled{opacity:.6;cursor:default}",
    ".ldz-note{padding:6px 16px 0;color:#525252;font-size:12.5px}",
    ".ldz-link{align-self:flex-start;margin:8px 16px 14px;padding:0;border:0;background:none;color:#525252;font:inherit;font-size:12.5px;text-decoration:underline;cursor:pointer}",
    ".ldz-form{padding:12px 16px 16px;display:flex;flex-direction:column;gap:8px}",
    ".ldz-form input,.ldz-form select,.ldz-form textarea{width:100%;box-sizing:border-box;padding:9px 10px;border:1px solid #d4d4d4;border-radius:8px;font:14px/1.3 system-ui,-apple-system,sans-serif;color:#171717;background:#fff}",
    ".ldz-form input:focus,.ldz-form select:focus,.ldz-form textarea:focus{outline:2px solid #171717;outline-offset:1px;border-color:#171717}",
    ".ldz-form textarea{min-height:74px;resize:vertical}",
    ".ldz-hp{position:absolute!important;left:-9999px!important;top:auto!important;width:1px!important;height:1px!important;overflow:hidden!important}",
    ".ldz-submit{margin-top:2px;padding:10px 12px;border:0;border-radius:8px;background:#171717;color:#fff;font:600 14px/1 system-ui,-apple-system,sans-serif;cursor:pointer}",
    ".ldz-submit:disabled{opacity:.6;cursor:default}",
    ".ldz-error{display:none;margin:10px 16px 0;padding:8px 10px;border-radius:8px;background:#fef2f2;color:#991b1b;font-size:12.5px}",
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

  var button = el("button", { type: "button", class: "ldz-btn", "aria-label": "Chat with us" }, document.body);
  button.textContent = "Chat with us";

  var panel = el("div", { class: "ldz-panel", role: "dialog", "aria-label": "Chat" }, document.body);

  /* ---------- shared request helpers ---------- */

  /** Trimmed values of the named fields that were actually filled in. */
  function collect(form, fields) {
    var data = {};
    for (var i = 0; i < fields.length; i++) {
      var node = form.querySelector("[name=" + fields[i] + "]");
      var value = node && node.value ? node.value.trim() : "";
      if (value) data[fields[i]] = value;
    }
    return data;
  }

  function request(url, options) {
    return fetch(url, options).then(function (response) {
      return response
        .json()
        .catch(function () { return null; })
        .then(function (payload) { return { status: response.status, payload: payload }; });
    });
  }

  /** The backend's own validation message when there is one. */
  function errorMessage(result, fallback) {
    if (
      result.payload &&
      result.payload.success === false &&
      result.payload.error &&
      result.payload.error.message
    ) {
      return result.payload.error.message;
    }
    return fallback;
  }

  /* ---------- shared qualification fields (§15, §17) ---------- */

  /** The blank first entry of a select — an optional field with no default. */
  function setPlaceholder(select, label) {
    var blank = el("option", { value: "" }, select);
    blank.textContent = label;
  }

  /** Urgency values are the backend's enum; labels match the dashboard (§16). */
  function fillUrgency(select) {
    var options = [
      ["", "How urgent? (optional)"],
      ["LOW", "Low (no rush)"],
      ["MEDIUM", "Medium (soon)"],
      ["HIGH", "High (urgent)"],
    ];
    for (var i = 0; i < options.length; i++) {
      var option = el("option", { value: options[i][0] }, select);
      option.textContent = options[i][1];
    }
  }

  /**
   * Fill a service select from the business's active services (§10). The
   * select stays hidden until the status call brings real options, so a
   * business with no services simply shows none.
   */
  function fillServices(select, services) {
    for (var i = 0; i < services.length; i++) {
      var option = el("option", { value: services[i].id }, select);
      option.textContent = services[i].name;
    }
    if (services.length) select.style.display = "";
  }

  /* ---------- details view: identity before the chat starts ---------- */

  var detailsView = el("div", { class: "ldz-detailsview" }, panel);
  var detailsHead = el("div", { class: "ldz-head" }, detailsView);
  detailsHead.textContent = "Chat with us";
  var detailsSub = el("div", { class: "ldz-sub" }, detailsView);
  detailsSub.textContent = "Tell us who you are and what you need, then start the chat.";
  var detailsError = el("div", { class: "ldz-error", role: "alert" }, detailsView);

  var detailsForm = el("form", { class: "ldz-form", novalidate: "novalidate" }, detailsView);
  el("input", { name: "name", type: "text", placeholder: "Your name *", required: "required", autocomplete: "name", maxlength: "120" }, detailsForm);
  el("input", { name: "phone", type: "tel", placeholder: "Phone", autocomplete: "tel", maxlength: "30" }, detailsForm);
  el("input", { name: "email", type: "email", placeholder: "Email", autocomplete: "email", maxlength: "254" }, detailsForm);
  // Optional qualification (§15, §17): the service comes from the business's
  // own list, plus urgency and a preferred date. The service select stays
  // hidden until the status call fills it.
  var detailsService = el("select", { name: "serviceId", "aria-label": "Service needed" }, detailsForm);
  setPlaceholder(detailsService, "Service needed (optional)");
  detailsService.style.display = "none";
  var detailsUrgency = el("select", { name: "urgency", "aria-label": "How urgent is it?" }, detailsForm);
  fillUrgency(detailsUrgency);
  el("input", { name: "preferredDate", type: "date", "aria-label": "Preferred date (optional)", title: "Preferred date (optional)" }, detailsForm);
  el("textarea", { name: "message", placeholder: "What do you need help with? *", required: "required", maxlength: "4000" }, detailsForm);
  // Honeypot: invisible to people, tempting to bots (see backend).
  el("input", { class: "ldz-hp", name: "website", type: "text", tabindex: "-1", autocomplete: "off", "aria-hidden": "true" }, detailsForm);
  var detailsSubmit = el("button", { type: "submit", class: "ldz-submit" }, detailsForm);
  detailsSubmit.textContent = "Start chat";

  var detailsNote = el("div", { class: "ldz-note" }, detailsView);
  detailsNote.textContent = "A phone number or email lets us reply if the chat closes.";
  var detailsFallback = el("button", { type: "button", class: "ldz-link" }, detailsView);
  detailsFallback.textContent = "Prefer to send an enquiry instead?";

  /* ---------- chat view ---------- */

  var chatView = el("div", { class: "ldz-chat" }, panel);
  var chatHead = el("div", { class: "ldz-head" }, chatView);
  chatHead.textContent = "Chat with us";
  var chatSub = el("div", { class: "ldz-sub" }, chatView);
  chatSub.textContent = "Ask us anything and we will reply here.";
  var chatError = el("div", { class: "ldz-error", role: "alert" }, chatView);
  var msgs = el("div", { class: "ldz-msgs", role: "log", "aria-live": "polite" }, chatView);
  var empty = el("div", { class: "ldz-empty" }, msgs);
  empty.textContent = "Send a message to start.";

  var compose = el("form", { class: "ldz-compose", novalidate: "novalidate" }, chatView);
  var input = el("input", { name: "message", type: "text", placeholder: "Type your message", maxlength: "4000", autocomplete: "off", "aria-label": "Message" }, compose);
  var send = el("button", { type: "submit", class: "ldz-send" }, compose);
  send.textContent = "Send";

  var chatNote = el("div", { class: "ldz-note" }, chatView);
  var fallback = el("button", { type: "button", class: "ldz-link" }, chatView);
  fallback.textContent = "Prefer to send an enquiry instead?";

  /* ---------- enquiry form view (step 18 fallback) ---------- */

  var formView = el("div", { class: "ldz-formview" }, panel);
  var formHead = el("div", { class: "ldz-head" }, formView);
  formHead.textContent = "How can we help?";
  var formSub = el("div", { class: "ldz-sub" }, formView);
  formSub.textContent = "Send a message and we will get back to you.";

  var formError = el("div", { class: "ldz-error", role: "alert" }, formView);
  var form = el("form", { class: "ldz-form", novalidate: "novalidate" }, formView);
  el("input", { name: "name", type: "text", placeholder: "Your name *", required: "required", autocomplete: "name", maxlength: "120" }, form);
  el("input", { name: "phone", type: "tel", placeholder: "Phone", autocomplete: "tel", maxlength: "30" }, form);
  el("input", { name: "email", type: "email", placeholder: "Email", autocomplete: "email", maxlength: "254" }, form);
  var formService = el("select", { name: "serviceId", "aria-label": "Service needed" }, form);
  setPlaceholder(formService, "Service needed (optional)");
  formService.style.display = "none";
  var formUrgency = el("select", { name: "urgency", "aria-label": "How urgent is it?" }, form);
  fillUrgency(formUrgency);
  el("input", { name: "preferredDate", type: "date", "aria-label": "Preferred date (optional)", title: "Preferred date (optional)" }, form);
  el("input", { name: "postcode", type: "text", placeholder: "Postcode", autocomplete: "postal-code", maxlength: "12" }, form);
  el("textarea", { name: "message", placeholder: "What do you need help with? *", required: "required", maxlength: "4000" }, form);
  el("input", { class: "ldz-hp", name: "website", type: "text", tabindex: "-1", autocomplete: "off", "aria-hidden": "true" }, form);
  var submit = el("button", { type: "submit", class: "ldz-submit" }, form);
  submit.textContent = "Send enquiry";

  var done = el("div", { class: "ldz-done" }, formView);
  var doneTitle = el("strong", {}, done);
  doneTitle.textContent = "Thanks — message sent!";
  var doneSub = el("span", {}, done);
  doneSub.textContent = "We will be in touch as soon as we can.";

  /* ---------- shared behaviour ---------- */

  // "details" → identity form, "chat" → the thread, "form" → enquiry fallback.
  var view = "details";
  var conversationId = null;
  var token = null;
  var visitorName = "";
  var pollTimer = null;
  var awaiting = false;
  // The visitor's own "typing" pings are throttled (see pingTyping).
  var TYPING_PING_MS = 4000;
  var lastTypingPing = 0;

  function openState() {
    return panel.classList.contains("ldz-open");
  }

  function toggle(open) {
    panel.classList.toggle("ldz-open", open);
  }

  function setView(next) {
    view = next;
    detailsView.style.display = next === "details" ? "block" : "none";
    chatView.style.display = next === "chat" ? "block" : "none";
    formView.style.display = next === "form" ? "block" : "none";
    var label = next === "form" ? "Send an enquiry" : "Chat with us";
    button.textContent = label;
    button.setAttribute("aria-label", label);
  }

  function focusField() {
    var first = null;
    if (view === "chat") {
      first = input;
    } else {
      var formNode = view === "form" ? form : detailsForm;
      first = formNode.querySelector("input[name=name]");
    }
    if (first) first.focus();
  }

  button.addEventListener("click", function () {
    var open = !openState();
    toggle(open);
    if (open) {
      focusField();
      // Resume live updates if a thread is already open; a closed panel does
      // not need to keep polling.
      if (view === "chat" && conversationId) startPolling();
    } else {
      stopPolling();
    }
  });

  /* ---------- starting a chat: details first ---------- */

  function setDetailsError(text) {
    detailsError.textContent = text || "";
    detailsError.style.display = text ? "block" : "none";
  }

  function setDetailsBusy(busy) {
    detailsSubmit.disabled = busy;
    detailsSubmit.textContent = busy ? "Starting…" : "Start chat";
  }

  detailsForm.addEventListener("submit", function (event) {
    event.preventDefault();
    setDetailsError("");

    var data = collect(detailsForm, ["name", "phone", "email", "serviceId", "urgency", "preferredDate", "message", "website"]);
    if (!data.name) { setDetailsError("Please enter your name."); return; }
    if (!data.message) { setDetailsError("Please describe what you need help with."); return; }
    if (!data.phone && !data.email) { setDetailsError("Add a phone number or email so we can reply."); return; }

    setDetailsBusy(true);
    // The details travel with the first message and become the customer/lead
    // record; the thread starts in the same round trip.
    request(chatBase, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(data),
    })
      .then(function (result) {
        var started =
          (result.status === 200 || result.status === 201) &&
          result.payload &&
          result.payload.success &&
          result.payload.data &&
          result.payload.data.conversationId &&
          result.payload.data.token;

        if (!started) {
          setDetailsError(errorMessage(result, "Sorry, something went wrong. Please try again."));
          return;
        }

        conversationId = result.payload.data.conversationId;
        token = result.payload.data.token;
        visitorName = data.name;
        // The details stay in the hidden form: if the session expires, the
        // visitor can restart the chat without retyping anything.
        setView("chat");
        chatSub.textContent = "You are chatting as " + visitorName + ".";
        setChatError("");
        // Optimistic bubble; the first poll replaces it with the server's list.
        addBubble(data.message);
        startPolling();
      })
      .catch(function () {
        setDetailsError("We could not reach the server. Check your connection and try again.");
      })
      .then(function () {
        setDetailsBusy(false);
      });
  });

  detailsFallback.addEventListener("click", function () {
    stopPolling();
    setBusy(false);
    setView("form");
    focusField();
  });

  /* ---------- chat ---------- */

  function setChatError(text) {
    chatError.textContent = text || "";
    chatError.style.display = text ? "block" : "none";
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function setBusy(busy) {
    awaiting = busy;
    send.disabled = busy;
    input.disabled = busy;
  }

  function addBubble(text) {
    if (empty && empty.parentNode) msgs.removeChild(empty);
    var bubble = el("div", { class: "ldz-msg ldz-msg-customer" }, msgs);
    bubble.textContent = text;
    msgs.scrollTop = msgs.scrollHeight;
  }

  function renderMessages(messages, typing) {
    while (msgs.firstChild) msgs.removeChild(msgs.firstChild);
    if (!messages.length) {
      var placeholder = el("div", { class: "ldz-empty" }, msgs);
      placeholder.textContent = "Send a message to start.";
      return;
    }
    for (var i = 0; i < messages.length; i++) {
      var message = messages[i];
      var bubble = el(
        "div",
        { class: "ldz-msg " + (message.sender === "CUSTOMER" ? "ldz-msg-customer" : "ldz-msg-agent") },
        msgs
      );
      bubble.textContent = message.content;
    }
    // "AI is typing…" while the agent composes, "Team is typing…" once a
    // person has taken the thread over (§22). A person is the stronger signal,
    // so they win if both are true.
    if (typing && (typing.AI || typing.HUMAN)) {
      var typingBubble = el("div", { class: "ldz-msg ldz-msg-agent ldz-typing" }, msgs);
      typingBubble.textContent = typing.HUMAN ? "Team is typing…" : "AI is typing…";
    }
    msgs.scrollTop = msgs.scrollHeight;
  }

  function fetchMessages() {
    var headers = {};
    if (token) headers["x-chat-token"] = token;
    return request(chatBase + "/" + encodeURIComponent(conversationId) + "/messages", { headers: headers });
  }

  /** Tell the backend the visitor is (or is no longer) typing (§22). */
  function pingTyping(active) {
    if (!conversationId || !token) return;
    var now = Date.now();
    if (active) {
      if (now - lastTypingPing < TYPING_PING_MS) return;
      lastTypingPing = now;
    } else {
      if (lastTypingPing === 0) return;
      lastTypingPing = 0;
    }
    request(chatBase + "/typing", {
      method: "POST",
      headers: { "content-type": "application/json", "x-chat-token": token },
      body: JSON.stringify({ conversationId: conversationId, typing: active }),
    }).catch(function () {});
  }

  function poll() {
    fetchMessages()
      .then(function (result) {
        if (result.status === 403) {
          // The thread token is gone (expired/invalid) — the visitor starts again.
          stopPolling();
          conversationId = null;
          token = null;
          setBusy(false);
          setView("details");
          setDetailsError("This chat session expired. Start a new chat and we will pick it up.");
          return;
        }
        if (result.status === 200 && result.payload && result.payload.success) {
          var data = result.payload.data;
          renderMessages(data.messages, data.typing);
        }
      })
      .catch(function () {
        // A failed poll is retried on the next tick; never interrupt the chat.
      });
  }

  /**
   * Keep the thread live while the panel is open. Earlier the widget stopped
   * after the first reply, so a later AI or staff message never reached the
   * visitor — now it polls continuously (every 2.5s) until the panel closes.
   */
  function startPolling() {
    stopPolling();
    chatNote.textContent = "";
    setBusy(false);
    pollTimer = setInterval(poll, 2500);
    poll();
  }

  // The visitor is typing: tell the dashboard so it can show "Customer is
  // typing…". Best-effort and throttled; the flag expires on its own.
  input.addEventListener("input", function () {
    if (input.value && input.value.trim()) pingTyping(true);
    else pingTyping(false);
  });

  compose.addEventListener("submit", function (event) {
    event.preventDefault();
    if (awaiting) return;

    var text = input.value ? input.value.trim() : "";
    if (!text) return;

    setChatError("");
    chatNote.textContent = "";
    input.value = "";
    pingTyping(false);
    addBubble(text);

    // Identity was collected up front, so a follow-up message only needs the
    // thread it belongs to.
    var body = { message: text };
    if (conversationId) body.conversationId = conversationId;
    var headers = { "content-type": "application/json" };
    if (token) headers["x-chat-token"] = token;

    setBusy(true);
    request(chatBase, { method: "POST", headers: headers, body: JSON.stringify(body) })
      .then(function (result) {
        if ((result.status === 200 || result.status === 201) && result.payload && result.payload.success) {
          conversationId = result.payload.data.conversationId;
          token = result.payload.data.token;
          startPolling();
          return;
        }
        if (result.status === 403) {
          conversationId = null;
          token = null;
          setView("details");
          setDetailsError("This chat session expired. Start a new chat and we will pick it up.");
          setBusy(false);
          return;
        }
        setChatError(errorMessage(result, "Sorry, something went wrong. Please try again."));
        setBusy(false);
      })
      .catch(function () {
        setChatError("We could not reach the server. Check your connection and try again.");
        setBusy(false);
      });
  });

  fallback.addEventListener("click", function () {
    stopPolling();
    setBusy(false);
    setView("form");
    focusField();
  });

  /* ---------- enquiry form ---------- */

  function showFormError(text) {
    formError.textContent = text;
    formError.style.display = "block";
  }

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    formError.style.display = "none";

    var data = collect(form, ["name", "phone", "email", "serviceId", "urgency", "preferredDate", "postcode", "message", "website"]);
    if (!data.name) { showFormError("Please enter your name."); return; }
    if (!data.message) { showFormError("Please describe what you need help with."); return; }
    if (!data.phone && !data.email) { showFormError("Add a phone number or email so we can reply."); return; }

    submit.disabled = true;
    submit.textContent = "Sending…";

    request(leadEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(data),
    })
      .then(function (result) {
        if (result.status === 200 || result.status === 201) {
          form.style.display = "none";
          done.style.display = "block";
          return;
        }
        showFormError(errorMessage(result, "Sorry, something went wrong. Please try again."));
      })
      .catch(function () {
        showFormError("We could not reach the server. Check your connection and try again.");
      })
      .then(function () {
        submit.disabled = false;
        submit.textContent = "Send enquiry";
      });
  });

  /* ---------- boot ---------- */

  // Ask the backend whether the AI is available; the chat is optional, so any
  // failure (or an off switch) quietly leaves the working enquiry form.
  setView("details");
  request(chatBase + "/status", {})
    .then(function (result) {
      if (result.status === 200 && result.payload && result.payload.success) {
        if (result.payload.data.businessName) {
          chatHead.textContent = result.payload.data.businessName;
          detailsHead.textContent = result.payload.data.businessName;
        }
        // Both views share the business's services for their select (§10) —
        // the enquiry form needs it even when the AI is off.
        var services = result.payload.data.services || [];
        fillServices(detailsService, services);
        fillServices(formService, services);
      }
      if (
        result.status === 200 &&
        result.payload &&
        result.payload.success &&
        result.payload.data.aiEnabled
      ) {
        setView("details");
        return;
      }
      setView("form");
    })
    .catch(function () {
      setView("form");
    });
})();
`;
