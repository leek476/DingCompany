(() => {
  'use strict';

  const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

  const state = {
    me: null,
    dashboard: null,
    documents: [],
    messages: [],
    admin: null,
    adminDocuments: [],
    adminDocumentsUnavailable: false,
    stageDraft: null,
    page: 'dashboard'
  };

  const authView = document.querySelector('#auth-view');
  const portal = document.querySelector('#portal');
  const content = document.querySelector('#page-content');
  const toast = document.querySelector('#toast');
  const authError = document.querySelector('#auth-error');
  const loginForm = document.querySelector('#login-form');
  const authTitle = document.querySelector('#auth-title');
  const authSubtitle = document.querySelector('#auth-subtitle');
  const crumb = document.querySelector('#crumb-label');
  const crumbDescription = document.querySelector('#crumb-description');
  const liveStatus = document.querySelector('#live-status');
  const menuButton = document.querySelector('[data-open-sidebar]');
  const sidebarOverlay = document.querySelector('.sidebar-overlay');

  let toastTimer;
  let pollTimer;
  let realtimeRefreshTimer;
  let realtimeRefreshInFlight = false;
  let realtimeRefreshQueued = false;
  let suppressHashHandling = false;
  const pendingRealtimeChanges = new Set();

  const pages = {
    dashboard: { title: 'Overview', subtitle: 'Client portal' },
    investment: { title: 'My investment', subtitle: 'Investment information' },
    project: { title: 'Project centre', subtitle: 'Programme delivery' },
    financials: { title: 'Financials', subtitle: 'Project economics' },
    documents: { title: 'Documents', subtitle: 'Secure document room' },
    messages: { title: 'Messages', subtitle: 'Project support' },
    profile: { title: 'My profile', subtitle: 'Account settings' },
    admin: { title: 'Administration', subtitle: 'Operations control centre' }
  };

  /* ---------------------------------------------------------------------
     Formatting helpers
     --------------------------------------------------------------------- */

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
    }[character]));
  }

  function toNumber(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : 0;
  }

  function clamp(value, min = 0, max = 100) {
    return Math.min(max, Math.max(min, toNumber(value)));
  }

  function money(value) {
    return new Intl.NumberFormat('en-US', {
      style: 'currency', currency: 'USD', maximumFractionDigits: 0
    }).format(toNumber(value));
  }

  function compactMoney(value) {
    return new Intl.NumberFormat('en-US', {
      style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1
    }).format(toNumber(value));
  }

  function percent(value) {
    const numeric = toNumber(value);
    return `${numeric.toFixed(numeric % 1 ? 1 : 0)}%`;
  }

  function ratio(part, whole) {
    const total = toNumber(whole);
    return total > 0 ? toNumber(part) / total : 0;
  }

  function dateLabel(value) {
    if (!value) return '—';
    const raw = String(value);
    const date = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? new Date(`${raw}T12:00:00`) : new Date(raw);
    return Number.isNaN(date.getTime())
      ? raw
      : new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(date);
  }

  function initials(name) {
    return String(name || '?').trim().split(/\s+/).filter(Boolean).slice(0, 2)
      .map((part) => part[0]).join('').toUpperCase() || '?';
  }

  function pluralise(count, singular, plural = `${singular}s`) {
    return `${count} ${count === 1 ? singular : plural}`;
  }

  /* ---------------------------------------------------------------------
     UI utilities
     --------------------------------------------------------------------- */

  function showToast(message, isError = false) {
    window.clearTimeout(toastTimer);
    toast.textContent = message;
    toast.classList.toggle('error', isError);
    toast.classList.add('show');
    toastTimer = window.setTimeout(() => toast.classList.remove('show'), 4000);
  }

  function setAuthError(message = '') {
    authError.textContent = message;
    authError.hidden = !message;
  }

  /* Keeps any markup inside the button (icons, spans) intact while busy. */
  function setButtonBusy(button, busy, busyText) {
    if (!button) return;
    if (busy) {
      if (button.dataset.idleMarkup === undefined) button.dataset.idleMarkup = button.innerHTML;
      button.textContent = busyText || 'Working…';
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
    } else {
      if (button.dataset.idleMarkup !== undefined) {
        button.innerHTML = button.dataset.idleMarkup;
        delete button.dataset.idleMarkup;
      }
      button.disabled = false;
      button.removeAttribute('aria-busy');
    }
  }

  /* Sign-in is the only auth view: accounts are created by an administrator. */
  function resetAuthView() {
    authTitle.textContent = 'Welcome back';
    authSubtitle.textContent = 'Sign in to view your project and investment information.';
    setAuthError();
  }

  function setTopBar() {
    const name = state.me?.profile?.name || state.me?.email || 'Account';
    document.querySelector('#top-user-name').textContent = name;
    document.querySelector('#top-user-role').textContent = state.me?.role === 'admin' ? 'Administrator' : 'Client partner';
    document.querySelector('#avatar').textContent = initials(name);
    document.querySelectorAll('.admin-only').forEach((item) => {
      item.hidden = state.me?.role !== 'admin';
    });
  }

  function openMenu() {
    portal.classList.add('menu-open');
    document.body.classList.add('nav-open');
    menuButton?.setAttribute('aria-expanded', 'true');
    if (sidebarOverlay) sidebarOverlay.hidden = false;
    document.querySelector('.portal-nav button:not([hidden])')?.focus();
  }

  function closeMenu(returnFocus = false) {
    if (!portal.classList.contains('menu-open')) {
      document.body.classList.remove('nav-open');
      return;
    }
    portal.classList.remove('menu-open');
    document.body.classList.remove('nav-open');
    menuButton?.setAttribute('aria-expanded', 'false');
    if (sidebarOverlay) sidebarOverlay.hidden = true;
    if (returnFocus && menuButton && getComputedStyle(menuButton).display !== 'none') menuButton.focus();
  }

  /* ---------------------------------------------------------------------
     API
     --------------------------------------------------------------------- */

  async function api(endpoint, options = {}) {
    const { json, ...rest } = options;
    const requestOptions = { credentials: 'same-origin', ...rest };
    requestOptions.headers = { Accept: 'application/json', ...(options.headers || {}) };
    if (json) {
      requestOptions.body = JSON.stringify(json);
      requestOptions.headers['Content-Type'] = 'application/json';
    }

    let response;
    try {
      response = await fetch(endpoint, requestOptions);
    } catch (networkError) {
      const error = new Error('We could not reach the server. Check your connection and try again.');
      error.status = 0;
      throw error;
    }

    const isJson = response.headers.get('content-type')?.includes('application/json');
    const payload = isJson ? await response.json().catch(() => null) : null;
    if (!response.ok) {
      const error = new Error(payload?.error || 'We could not complete that request. Please try again.');
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  async function loadDashboard() {
    const data = await api('/api/dashboard');
    state.dashboard = data;
    state.me = data.user;
    setTopBar();
  }

  function pageFromHash() {
    const candidate = String(location.hash || '').replace(/^#\/?/, '');
    return pages[candidate] ? candidate : 'dashboard';
  }

  /* The admin-documents endpoint is new and may not exist on every backend
     yet. A missing route should degrade the "Uploaded documents" panel
     alone, not take down the rest of the admin page (or the realtime
     refresh loop) every few seconds. Only a 401 propagates, so the normal
     session-expiry handling still applies. */
  async function loadAdminDocuments() {
    try {
      const data = await api('/api/admin/documents');
      state.adminDocuments = data.documents || [];
      state.adminDocumentsUnavailable = false;
    } catch (error) {
      if (error.status === 401) throw error;
      state.adminDocuments = [];
      state.adminDocumentsUnavailable = true;
    }
  }

  function syncHash(page) {
    const target = `#/${page}`;
    if (location.hash === target) return;
    suppressHashHandling = true;
    history.replaceState(null, '', target);
    window.setTimeout(() => { suppressHashHandling = false; }, 0);
  }

  async function launchPortal() {
    await loadDashboard();
    authView.hidden = true;
    portal.hidden = false;
    openRealtimeConnection();
    await navigate(pageFromHash(), true, true);
  }

  function signOutLocally(message) {
    closeRealtimeConnection();
    closeMenu();
    state.me = null;
    state.dashboard = null;
    state.documents = [];
    state.messages = [];
    state.admin = null;
    state.adminDocuments = [];
    state.adminDocumentsUnavailable = false;
    state.stageDraft = null;
    portal.hidden = true;
    authView.hidden = false;
    loginForm.reset();
    resetAuthView();
    if (message) setAuthError(message);
  }

  function updateNavigation() {
    const pageInfo = pages[state.page] || pages.dashboard;
    crumb.textContent = pageInfo.title;
    crumbDescription.textContent = pageInfo.subtitle;
    document.querySelectorAll('.portal-nav [data-page]').forEach((button) => {
      const isActive = button.dataset.page === state.page;
      button.classList.toggle('active', isActive);
      if (isActive) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
    document.title = `${pageInfo.title} | Intercoastal Water LLC`;
  }

  async function navigate(nextPage, force = false, dashboardAlreadyLoaded = false) {
    if (!pages[nextPage]) nextPage = 'dashboard';
    if (nextPage === 'admin' && state.me?.role !== 'admin') nextPage = 'dashboard';
    if (!force && nextPage === state.page) {
      closeMenu();
      return;
    }

    state.page = nextPage;
    updateNavigation();
    syncHash(nextPage);
    closeMenu();
    content.setAttribute('aria-busy', 'true');
    content.innerHTML = '<div class="loading">Loading your workspace…</div>';

    try {
      if (nextPage === 'documents') state.documents = (await api('/api/documents')).documents || [];
      if (nextPage === 'messages') {
        state.messages = (await api('/api/messages')).messages || [];
        if (state.me?.role === 'admin' && !state.admin) state.admin = await api('/api/admin/summary');
      }
      if (nextPage === 'admin') {
        state.admin = await api('/api/admin/summary');
        await loadAdminDocuments();
        state.stageDraft = cloneStages(projectData().stages);
      } else {
        state.stageDraft = null;
      }
      if (nextPage === 'dashboard' && !dashboardAlreadyLoaded) await loadDashboard();
      renderCurrentPage();
      content.focus({ preventScroll: true });
      window.scrollTo({ top: 0, behavior: 'auto' });
    } catch (error) {
      if (error.status === 401) {
        signOutLocally('Your session has ended. Please sign in again.');
        return;
      }
      content.innerHTML = `<div class="empty-state"><div><strong>This page did not load.</strong><p>${escapeHtml(error.message)}</p><button class="button button-secondary" type="button" data-go="${escapeHtml(nextPage)}">Try again</button></div></div>`;
      showToast(error.message, true);
    } finally {
      content.setAttribute('aria-busy', 'false');
    }
  }

  /* ---------------------------------------------------------------------
     Live updates — polling, not push

     The original design used Server-Sent Events (a held-open connection
     the server pushed change notifications through). Vercel's serverless
     functions can't hold a connection open like that, so this polls
     instead: every 20s, while the tab is visible, it asks the server for
     fresh data the same way an SSE-triggered refresh used to. Everything
     below queueRealtimeRefresh() — the "don't refresh out from under an
     open form" guards, the retry-on-failure logic — is unchanged; only
     what *starts* a refresh cycle is different.
     --------------------------------------------------------------------- */

  function setLiveStatus(status) {
    if (!liveStatus) return;
    const labels = {
      live: 'Auto-refresh on',
      refreshing: 'Refreshing…',
      pending: 'New data ready',
      reconnecting: 'Refresh failed — retrying',
      offline: 'Auto-refresh paused'
    };
    liveStatus.dataset.status = status;
    liveStatus.textContent = labels[status] || labels.offline;
  }

  function hasActiveEditor() {
    const activeElement = document.activeElement;
    return Boolean(
      activeElement
      && content.contains(activeElement)
      && activeElement.matches('input:not([disabled]), textarea:not([disabled]), select:not([disabled])')
    );
  }

  function hasUnsavedPortalChanges() {
    return [...content.querySelectorAll('form')].some((form) => [...form.elements].some((field) => {
      if (!field.name || field.disabled) return false;
      if (field.type === 'file') return Boolean(field.files?.length);
      if (field.tagName === 'SELECT') return [...field.options].some((option) => option.selected !== option.defaultSelected);
      return field.value !== field.defaultValue;
    }));
  }

  function queueRealtimeRefresh(changeType = 'portal') {
    if (!state.me) return;
    pendingRealtimeChanges.add(changeType);
    window.clearTimeout(realtimeRefreshTimer);
    realtimeRefreshTimer = window.setTimeout(refreshFromRealtime, 180);
  }

  async function refreshFromRealtime() {
    if (!state.me || !pendingRealtimeChanges.size) return;
    if (realtimeRefreshInFlight) {
      realtimeRefreshQueued = true;
      return;
    }
    if (hasActiveEditor() || hasUnsavedPortalChanges()) {
      realtimeRefreshQueued = true;
      setLiveStatus('pending');
      return;
    }

    realtimeRefreshInFlight = true;
    realtimeRefreshQueued = false;
    pendingRealtimeChanges.clear();
    setLiveStatus('refreshing');
    try {
      await loadDashboard();
      if (state.page === 'documents') state.documents = (await api('/api/documents')).documents || [];
      if (state.page === 'messages') state.messages = (await api('/api/messages')).messages || [];
      if (state.me?.role === 'admin' && (state.page === 'admin' || state.page === 'messages')) {
        state.admin = await api('/api/admin/summary');
      }
      if (state.me?.role === 'admin' && state.page === 'admin') {
        await loadAdminDocuments();
      }
      renderCurrentPage();
      setLiveStatus('live');
    } catch (error) {
      if (error.status === 401) signOutLocally('Your session has ended. Please sign in again.');
      else setLiveStatus('reconnecting');
    } finally {
      realtimeRefreshInFlight = false;
      if (realtimeRefreshQueued || pendingRealtimeChanges.size) {
        realtimeRefreshQueued = false;
        window.clearTimeout(realtimeRefreshTimer);
        realtimeRefreshTimer = window.setTimeout(refreshFromRealtime, 320);
      }
    }
  }

  function openRealtimeConnection() {
    closeRealtimeConnection(false);
    setLiveStatus('live');
    pollTimer = window.setInterval(() => {
      if (document.visibilityState === 'visible') queueRealtimeRefresh('poll');
    }, 20000);
  }

  function closeRealtimeConnection(updateStatus = true) {
    window.clearTimeout(realtimeRefreshTimer);
    realtimeRefreshTimer = undefined;
    pendingRealtimeChanges.clear();
    realtimeRefreshQueued = false;
    if (pollTimer) {
      window.clearInterval(pollTimer);
      pollTimer = undefined;
    }
    if (updateStatus) setLiveStatus('offline');
  }

  /* ---------------------------------------------------------------------
     Shared markup
     --------------------------------------------------------------------- */

  function pageHeading(title, description, actions = '') {
    return `<div class="page-heading"><div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(description)}</p></div>${actions ? `<div class="heading-actions">${actions}</div>` : ''}</div>`;
  }

  /* A percentage-width fill bar, rendered as an inline SVG rather than an
     element with a `style="width:...%"` attribute. Setting the `style`
     attribute — even dynamically from JS — is blocked under a strict
     style-src: 'self' CSP with no 'unsafe-inline'; SVG presentation
     attributes like `width` are not, so this achieves the same visual
     result without violating it. Drop it inside any track element that
     already defines the box (.meter, .bar, .dashboard-mini-progress,
     .dashboard-progress-row > div) — CSS handles color per track. */
  function fillBar(pct) {
    const width = clamp(pct);
    return `<svg class="fill" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><rect x="0" y="0" width="${width}" height="100" rx="50"/></svg>`;
  }

  /* Same reasoning, for a bar that grows in height from the bottom of a
     fixed-height track (the financials chart). */
  function chartBar(pct) {
    const height = Math.max(6, clamp(pct));
    return `<svg class="chart-bar" viewBox="0 0 10 100" preserveAspectRatio="none" aria-hidden="true"><rect x="0" y="${100 - height}" width="10" height="${height}" rx="1.5"/></svg>`;
  }


  function projectData() { return state.dashboard?.project || {}; }
  function overviewData() { return state.dashboard?.overview || {}; }

  function documentRows(documents, emptyTitle = 'No documents yet', emptyCopy = 'Files shared by your project administrator appear here.') {
    if (!documents?.length) {
      return `<div class="empty-state"><div><strong>${escapeHtml(emptyTitle)}</strong><p>${escapeHtml(emptyCopy)}</p></div></div>`;
    }
    return `<div class="doc-list">${documents.map((file) => `
      <div class="document-row">
        <div class="doc-symbol" aria-hidden="true">PDF</div>
        <div class="doc-copy">
          <strong title="${escapeHtml(file.title)}">${escapeHtml(file.title)}</strong>
          <span>${escapeHtml(file.description || file.originalName || 'Project document')} · ${escapeHtml(dateLabel(file.createdAt))}</span>
        </div>
        <a class="download-link" href="/api/documents/${encodeURIComponent(file.id)}/download" download>Download<span class="visually-hidden"> ${escapeHtml(file.title)}</span></a>
      </div>`).join('')}</div>`;
  }

  /* Admin-only row: same layout as documentRows, plus a delete control and a
     recipient label, since an admin needs to see who a file was sent to. */
  function adminDocumentRows(documents, clients) {
    if (!documents?.length) {
      return '<div class="empty-state"><div><strong>No documents uploaded yet</strong><p>PDFs you upload and send to clients appear here.</p></div></div>';
    }
    return `<div class="doc-list">${documents.map((file) => {
      const recipient = file.audience && file.audience !== 'all'
        ? clients.find((user) => user.id === file.audience)
        : null;
      const audienceLabel = !file.audience || file.audience === 'all'
        ? 'All portal users'
        : (recipient ? recipient.name : 'One client');
      return `
      <div class="document-row">
        <div class="doc-symbol" aria-hidden="true">PDF</div>
        <div class="doc-copy">
          <strong title="${escapeHtml(file.title)}">${escapeHtml(file.title)}</strong>
          <span>${escapeHtml(audienceLabel)} · ${escapeHtml(dateLabel(file.createdAt))}</span>
        </div>
        <div class="doc-actions">
          <a class="download-link" href="/api/documents/${encodeURIComponent(file.id)}/download" download>Download<span class="visually-hidden"> ${escapeHtml(file.title)}</span></a>
          <button class="icon-button delete-doc-button" type="button" data-delete-document="${escapeHtml(file.id)}" data-document-title="${escapeHtml(file.title)}" aria-label="Delete ${escapeHtml(file.title)}">&times;</button>
        </div>
      </div>`;
    }).join('')}</div>`;
  }

  function updateRows(updates) {
    if (!updates?.length) {
      return '<div class="empty-state"><div><strong>No updates yet</strong><p>Project leadership publishes verified field updates here.</p></div></div>';
    }
    return `<div class="update-list">${updates.map((update) => `
      <article class="update">
        <time>${escapeHtml(dateLabel(update.date))}</time>
        <i class="update-dot" aria-hidden="true"></i>
        <div><h3>${escapeHtml(update.title)}</h3><p>${escapeHtml(update.body)}</p></div>
      </article>`).join('')}</div>`;
  }

  /* ---------------------------------------------------------------------
     Pages
     --------------------------------------------------------------------- */

  function dashboardPage() {
    const project = projectData();
    const overview = overviewData();
    const value = toNumber(project.totalProjectValue);
    const cost = toNumber(project.estimatedProjectCost);
    const margin = toNumber(overview.expectedProjectMargin);
    const progress = clamp(project.projectProgress);
    const costPercent = clamp(ratio(cost, value) * 100);
    const investment = toNumber(overview.yourInvestment);
    const deployed = investment * (progress / 100);
    const remaining = Math.max(0, investment - deployed);
    const marginShare = investment * ratio(margin, value);
    const donutCircumference = 314;
    const stages = project.stages || [];
    const activeStage = stages.find((stage) => stage.status === 'current')
      || [...stages].reverse().find((stage) => stage.status === 'complete');
    const visibleUpdates = (project.updates || []).slice(0, 3);

    const stageNodes = stages.map((stage, index) => {
      const stageState = stage.status === 'complete' ? 'done' : stage.status === 'current' ? 'current' : 'upcoming';
      const label = stageState === 'done' ? 'Complete' : stageState === 'current' ? 'In progress' : 'Upcoming';
      const marker = stageState === 'done' ? '✓' : index + 1;
      return `<div class="dashboard-stage ${stageState}">
        <div class="dashboard-stage-dot" aria-hidden="true">${marker}</div>
        <div class="dashboard-stage-text"><strong>${escapeHtml(stage.name)}</strong><span>${label}</span></div>
        <small>${escapeHtml(stage.date || '')}</small>
      </div>`;
    }).join('');

    return `<div class="dashboard-home">
      ${pageHeading(`Welcome, ${state.me?.profile?.name?.split(' ')[0] || 'partner'}`, 'Your private view of project delivery and investment activity.')}

      <section class="dashboard-hero">
        <svg class="dashboard-hero-art" viewBox="0 0 520 300" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">
          <defs><linearGradient id="dash-water" x1="0" x2="1" y1="0" y2="1"><stop stop-color="#2fa895" stop-opacity=".72"/><stop offset="1" stop-color="#1b6d64" stop-opacity=".12"/></linearGradient></defs>
          <circle cx="398" cy="72" r="76" fill="none" stroke="#8fd3c4" stroke-opacity=".22"/>
          <circle cx="398" cy="72" r="112" fill="none" stroke="#8fd3c4" stroke-opacity=".14"/>
          <path d="M160 262C236 218 272 245 333 221C392 198 442 217 520 170V300H160Z" fill="url(#dash-water)"/>
          <path d="M229 223h219" stroke="#0e3e40" stroke-width="7"/>
          <path d="M259 223l17-62h65l-18 62Z" fill="#0f4d4c"/>
          <rect x="353" y="101" width="28" height="122" rx="4" fill="#1b756b"/>
          <rect x="395" y="68" width="28" height="155" rx="4" fill="#217f73"/>
          <rect x="437" y="115" width="28" height="108" rx="4" fill="#1b756b"/>
          <circle cx="367" cy="84" r="15" fill="#2fa895"/><circle cx="409" cy="52" r="15" fill="#2fa895"/>
        </svg>
        <div class="dashboard-hero-copy">
          <p>${escapeHtml(project.location || 'Coastal service district')} · Integrated utility programme</p>
          <h2>Integrated power, water supply and sewage treatment</h2>
          <span>${escapeHtml(project.name || 'Intercoastal Water LLC')}</span>
        </div>
        <div class="dashboard-hero-note">
          <span>Programme focus</span>
          <strong>Clean water<br>Reliable power<br>Resilient communities</strong>
        </div>
      </section>

      <section class="dashboard-stat-strip" aria-label="Key project figures">
        <article class="dashboard-stat-card">
          <div class="dashboard-stat-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v10M9 9.5c0-1.4 1.3-2.5 3-2.5s3 .9 3 2c0 3-6 1.5-6 4.5 0 1.1 1.3 2 3 2s3-1.1 3-2.5"/></svg></div>
          <span>Your investment</span><strong>${compactMoney(investment)}</strong>
          <small>${percent(overview.investmentShare)} of current project value</small>
        </article>
        <article class="dashboard-stat-card">
          <div class="dashboard-stat-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3l8 4v5c0 5-3.4 8.5-8 9.5C7.4 20.5 4 17 4 12V7z"/></svg></div>
          <span>Total project value</span><strong>${compactMoney(value)}</strong>
          <small>Contracted programme value</small>
        </article>
        <article class="dashboard-stat-card">
          <div class="dashboard-stat-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 20V10M12 20V4M20 20v-7"/><path d="M2 20h20"/></svg></div>
          <span>Estimated project cost</span><strong>${compactMoney(cost)}</strong>
          <small>${percent(costPercent)} of contracted value</small>
        </article>
        <article class="dashboard-stat-card">
          <div class="dashboard-stat-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg></div>
          <span>Project progress</span><strong>${percent(progress)}</strong>
          <div class="dashboard-mini-progress" role="img" aria-label="${percent(progress)} complete">${fillBar(progress)}</div>
        </article>
        <article class="dashboard-stat-card">
          <div class="dashboard-stat-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 9h18M8 3v4M16 3v4"/></svg></div>
          <span>Current phase</span><strong class="dashboard-stage-value">${escapeHtml(activeStage?.name || project.status || 'Active')}</strong>
          <small>${escapeHtml(project.duration || 'Delivery programme')}</small>
        </article>
      </section>

      <section class="dashboard-primary-grid">
        <article class="dashboard-panel">
          <div class="dashboard-panel-head"><h3>Investment overview</h3><button class="text-link" type="button" data-go="investment">View details</button></div>
          <div class="dashboard-donut-layout">
            <div class="dashboard-donut">
              <svg viewBox="0 0 120 120" aria-hidden="true" focusable="false">
                <circle cx="60" cy="60" r="50" fill="none" stroke="#e3e5dd" stroke-width="14"/>
                <circle cx="60" cy="60" r="50" fill="none" stroke="#2fa895" stroke-width="14" stroke-linecap="round" transform="rotate(-90 60 60)" stroke-dasharray="${(donutCircumference * progress / 100).toFixed(1)} ${donutCircumference}"/>
              </svg>
              <div><strong>${compactMoney(investment)}</strong><span>Your investment</span></div>
            </div>
            <div class="dashboard-investment-legend">
              <div class="dashboard-legend-row"><i class="deployed" aria-hidden="true"></i><span>Capital deployed</span><strong>${money(deployed)}</strong></div>
              <div class="dashboard-legend-row"><i class="remaining" aria-hidden="true"></i><span>Remaining capital</span><strong>${money(remaining)}</strong></div>
              <div class="dashboard-return-row"><span>Illustrative proportional margin</span><strong>${money(marginShare)}</strong></div>
            </div>
          </div>
        </article>

        <article class="dashboard-panel">
          <div class="dashboard-panel-head"><h3>Project financials</h3><button class="text-link" type="button" data-go="financials">View financials</button></div>
          <div class="dashboard-kv-list">
            <div><span>Contract value</span><strong>${money(value)}</strong></div>
            <div><span>Estimated project cost</span><strong>${money(cost)}</strong></div>
            <div><span>Estimated project margin</span><strong>${money(margin)}</strong></div>
            <div><span>Your investment</span><strong>${money(investment)}</strong></div>
            <div class="dashboard-kv-emphasis"><span>Project delivery</span><strong>${percent(progress)}</strong></div>
          </div>
        </article>

        <article class="dashboard-panel">
          <div class="dashboard-panel-head"><h3>Recent updates</h3><button class="text-link" type="button" data-go="project">View all</button></div>
          <div class="dashboard-updates">${visibleUpdates.length
            ? visibleUpdates.map((update) => `<article class="dashboard-update"><time>${escapeHtml(dateLabel(update.date))}</time><strong>${escapeHtml(update.title)}</strong><p>${escapeHtml(update.body)}</p></article>`).join('')
            : '<p class="dashboard-empty-copy">Verified delivery updates appear here.</p>'}</div>
        </article>
      </section>

      <section class="dashboard-timeline-panel">
        <div class="dashboard-panel-head">
          <div><h3>Project timeline</h3><p>Measured milestones from site preparation through final commissioning.</p></div>
          <span>${percent(progress)} complete</span>
        </div>
        <div class="dashboard-timeline-track">${stageNodes || '<p class="dashboard-empty-copy">Milestones are being scheduled.</p>'}</div>
        <div class="dashboard-progress-row">
          <div role="img" aria-label="Overall progress ${percent(progress)}">${fillBar(progress)}</div>
          <span>Overall project progress <strong>${percent(progress)}</strong></span>
        </div>
      </section>

      <section class="dashboard-bottom-grid">
        <article class="dashboard-site-panel">
          <div class="dashboard-site-art">
            <svg viewBox="0 0 650 360" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">
              <defs><linearGradient id="site-sky" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#dcebe5"/><stop offset="1" stop-color="#a5d1c4"/></linearGradient></defs>
              <rect width="650" height="360" fill="url(#site-sky)"/>
              <rect y="235" width="650" height="125" fill="#75b5a5"/>
              <path d="M0 279C105 245 161 288 281 255C398 222 512 282 650 239V360H0Z" fill="#579d90"/>
              <path d="M0 306C115 283 213 321 324 294C439 266 551 307 650 275V360H0Z" fill="#43897f"/>
              <g fill="#2f665e"><rect x="68" y="153" width="89" height="102" rx="3"/><rect x="175" y="132" width="64" height="123" rx="3"/><rect x="274" y="183" width="89" height="72" rx="4"/></g>
              <g fill="#23564f"><circle cx="441" cy="225" r="31"/><circle cx="511" cy="232" r="25"/><circle cx="569" cy="218" r="32"/></g>
              <path d="M59 255H598" stroke="#1d534c" stroke-width="5" opacity=".62"/>
              <circle cx="541" cy="64" r="31" fill="#fae4a6" opacity=".9"/>
            </svg>
            <span>Integrated utility delivery site</span>
          </div>
          <div class="dashboard-site-details">
            <div class="dashboard-panel-head"><h3>Project details</h3><button class="text-link" type="button" data-go="project">Project centre</button></div>
            <div class="dashboard-kv-list">
              <div><span>Project type</span><strong>Integrated utility</strong></div>
              <div><span>Location</span><strong>${escapeHtml(project.location || '—')}</strong></div>
              <div><span>Start date</span><strong>${escapeHtml(dateLabel(project.startDate))}</strong></div>
              <div><span>Target completion</span><strong>${escapeHtml(dateLabel(project.projectedCompletion))}</strong></div>
              <div><span>Operating capacity</span><strong>${escapeHtml(project.capacity || '—')}</strong></div>
            </div>
          </div>
        </article>

        <article class="dashboard-panel dashboard-documents-panel">
          <div class="dashboard-panel-head"><div><h3>Documents</h3><p>Agreements and delivery reports.</p></div><button class="text-link" type="button" data-go="documents">View all</button></div>
          ${documentRows(state.dashboard?.recentDocuments || [], 'Your document room is ready', 'Your administrator can share project reports and agreements straight to this portal.')}
          <div class="dashboard-notice">
            <span aria-hidden="true">✦</span>
            <div>
              <strong>Stay informed</strong>
              <p>Milestones and document uploads are shared through your secure account.</p>
              <button type="button" data-go="messages">Contact project support</button>
            </div>
          </div>
        </article>
      </section>
    </div>`;
  }

  function investmentPage() {
    const project = projectData();
    const overview = overviewData();
    const value = toNumber(project.totalProjectValue);
    const investment = toNumber(overview.yourInvestment);
    const margin = toNumber(overview.expectedProjectMargin);
    const marginShare = investment * Math.max(0, ratio(margin, value));

    return `${pageHeading('My investment', 'Your contribution and the project metrics it supports.', '<button class="button button-secondary" type="button" data-go="documents">View agreements</button>')}
      <section class="detail-hero panel">
        <div>
          <p class="section-kicker">Investment position</p>
          <div class="feature-number">${money(investment)}</div>
          <div class="feature-label">Recorded contribution to the ${escapeHtml(project.name || 'programme')}</div>
          <div class="meter" role="img" aria-label="Share of project value ${percent(overview.investmentShare)}">${fillBar(overview.investmentShare)}</div>
        </div>
        <div class="stat-list">
          <div class="stat-row"><span>Ownership share</span><strong class="positive">${percent(overview.investmentShare)}</strong></div>
          <div class="stat-row"><span>Programme value</span><strong>${money(value)}</strong></div>
          <div class="stat-row"><span>Current delivery</span><strong>${percent(project.projectProgress)}</strong></div>
          <div class="stat-row"><span>Project margin</span><strong>${money(margin)}</strong></div>
        </div>
      </section>

      <section class="content-grid equal">
        <article class="panel">
          <div class="panel-head"><div><h2>Programme capital view</h2><p>Estimated distribution of the contracted programme value.</p></div></div>
          <div class="allocation">
            <div class="allocation-row"><span>Estimated delivery cost</span><div class="bar">${fillBar(ratio(project.estimatedProjectCost, value) * 100)}</div><strong>${money(project.estimatedProjectCost)}</strong></div>
            <div class="allocation-row"><span>Expected project margin</span><div class="bar gold">${fillBar(ratio(margin, value) * 100)}</div><strong>${money(margin)}</strong></div>
            <div class="allocation-row"><span>Your contribution</span><div class="bar blue">${fillBar(overview.investmentShare)}</div><strong>${money(investment)}</strong></div>
          </div>
        </article>
        <article class="panel">
          <div class="panel-head"><div><h2>Contribution summary</h2><p>Review alongside your executed documentation.</p></div></div>
          <div class="financial-list">
            <div class="financial-row"><span>Current contribution</span><strong>${money(investment)}</strong><em>Maintained by your project administrator.</em></div>
            <div class="financial-row"><span>Share of total value</span><strong>${percent(overview.investmentShare)}</strong><em>Calculated against current project value.</em></div>
            <div class="financial-row highlight"><span>Illustrative proportional margin</span><strong>${money(marginShare)}</strong><em>Not a promise of return. Subject to executed agreements and project performance.</em></div>
          </div>
        </article>
      </section>`;
  }

  function projectPage() {
    const project = projectData();
    const stages = project.stages || [];
    const progress = clamp(project.projectProgress);

    return `${pageHeading('Project centre', 'Programme activity, milestones and operating focus.', '<button class="button button-secondary" type="button" data-go="messages">Contact project team</button>')}
      <section class="hero-card">
        <div>
          <p class="eyebrow">${escapeHtml(project.location || 'Coastal service district')}</p>
          <h2>${escapeHtml(project.sector || 'Integrated utility infrastructure')}</h2>
          <p>${escapeHtml(project.description || '')}</p>
        </div>
        <div class="hero-insight">
          <span>Operating capacity</span>
          <strong>${escapeHtml(project.capacity || '—')}</strong>
          <small>${escapeHtml(project.status || 'Active')}</small>
        </div>
      </section>

      <section class="panel u-mb-16">
        <div class="panel-head">
          <div><h2>Delivery timeline</h2><p>Current project milestones and delivery progress.</p></div>
          <span class="pill ${progress < 50 ? 'warn' : ''}">${percent(progress)} complete</span>
        </div>
        <div class="timeline">${stages.length ? stages.map((stage, index) => `
          <div class="milestone ${escapeHtml(stage.status || 'upcoming')}">
            <b aria-hidden="true">${stage.status === 'complete' ? '✓' : index + 1}</b>
            <strong>${escapeHtml(stage.name)}</strong>
            <span>${escapeHtml(stage.date || '')}</span>
          </div>`).join('') : '<p class="dashboard-empty-copy">Milestones are being scheduled.</p>'}</div>
        <div class="progress-wrap">
          <div class="progress-label"><span>Overall project progress</span><strong>${percent(progress)}</strong></div>
          <div class="meter">${fillBar(progress)}</div>
        </div>
      </section>

      <section class="content-grid">
        <article class="panel">
          <div class="panel-head"><div><h2>Project updates</h2><p>Field and delivery updates from project leadership.</p></div></div>
          ${updateRows(project.updates)}
        </article>
        <article class="panel">
          <div class="panel-head"><div><h2>Project details</h2><p>Programme operating profile.</p></div></div>
          <div class="stat-list">
            <div class="stat-row"><span>Project type</span><strong>Integrated utility</strong></div>
            <div class="stat-row"><span>Power service</span><strong>Reliable generation</strong></div>
            <div class="stat-row"><span>Water service</span><strong>Treated water supply</strong></div>
            <div class="stat-row"><span>Treatment service</span><strong>Sewage treatment</strong></div>
            <div class="stat-row"><span>Duration</span><strong>${escapeHtml(project.duration || '—')}</strong></div>
            <div class="stat-row"><span>Target completion</span><strong>${escapeHtml(dateLabel(project.projectedCompletion))}</strong></div>
          </div>
        </article>
      </section>`;
  }

  function financialsPage() {
    const project = projectData();
    const overview = overviewData();
    const cost = toNumber(project.estimatedProjectCost);
    const value = toNumber(project.totalProjectValue);
    const margin = Math.max(0, value - cost);
    const investment = toNumber(overview.yourInvestment);
    const barHeight = (part) => Math.max(6, clamp(ratio(part, value) * 100));

    return `${pageHeading('Project financials', 'Current programme figures maintained by Intercoastal Water LLC.')}
      <section class="metric-grid">
        <article class="metric-card"><div class="metric-label">Contract value <span class="metric-symbol" aria-hidden="true">◇</span></div><div class="metric-value">${compactMoney(value)}</div><div class="metric-foot">Total programme value</div></article>
        <article class="metric-card"><div class="metric-label">Estimated cost <span class="metric-symbol" aria-hidden="true">▧</span></div><div class="metric-value">${compactMoney(cost)}</div><div class="metric-foot">Current delivery estimate</div></article>
        <article class="metric-card"><div class="metric-label">Projected margin <span class="metric-symbol" aria-hidden="true">+</span></div><div class="metric-value">${compactMoney(margin)}</div><div class="metric-foot">Before investor allocation</div></article>
        <article class="metric-card"><div class="metric-label">Your position <span class="metric-symbol" aria-hidden="true">$</span></div><div class="metric-value">${compactMoney(investment)}</div><div class="metric-foot">${percent(overview.investmentShare)} of project value</div></article>
      </section>

      <section class="content-grid equal">
        <article class="panel">
          <div class="panel-head"><div><h2>Programme financial summary</h2><p>Current approved project figures.</p></div></div>
          <div class="financial-list">
            <div class="financial-row"><span>Total project value</span><strong>${money(value)}</strong><em>Contracted programme value.</em></div>
            <div class="financial-row"><span>Estimated project cost</span><strong>${money(cost)}</strong><em>Latest administrator-maintained delivery estimate.</em></div>
            <div class="financial-row highlight"><span>Estimated project margin</span><strong>${money(margin)}</strong><em>Value less estimated cost; not a projected personal return.</em></div>
            <div class="financial-row"><span>Your recorded investment</span><strong>${money(investment)}</strong><em>Your individual contribution on file.</em></div>
          </div>
        </article>
        <article class="panel">
          <div class="panel-head"><div><h2>Value composition</h2><p>Relative value across the programme cycle.</p></div></div>
          <div class="chart" role="img" aria-label="Contract value ${money(value)}, cost ${money(cost)}, margin ${money(margin)}, your position ${money(investment)}">
            <div class="chart-col"><div class="chart-bar-track">${chartBar(100)}</div><span>Value</span></div>
            <div class="chart-col"><div class="chart-bar-track">${chartBar(barHeight(cost))}</div><span>Cost</span></div>
            <div class="chart-col"><div class="chart-bar-track">${chartBar(barHeight(margin))}</div><span>Margin</span></div>
            <div class="chart-col"><div class="chart-bar-track">${chartBar(barHeight(investment))}</div><span>Yours</span></div>
          </div>
          <p class="form-note u-mt-17">These are project-level operating figures. Refer to signed agreements for legal and investment terms.</p>
        </article>
      </section>`;
  }

  function documentsPage() {
    const count = state.documents.length;
    return `${pageHeading('Document room', 'Project files your administrator has shared with you.', state.me?.role === 'admin' ? '<button class="button button-primary" type="button" data-go="admin">Upload a PDF</button>' : '')}
      <section class="content-grid">
        <article class="panel">
          <div class="panel-head"><div><h2>Shared documents</h2><p>PDF files shared with your account or with all project partners.</p></div><span class="pill gray">${pluralise(count, 'file')}</span></div>
          ${documentRows(state.documents)}
        </article>
        <aside class="stack">
          <article class="panel">
            <div class="panel-head"><div><h2>How documents are shared</h2></div></div>
            <div class="stat-list">
              <div class="stat-row"><span>Step 1</span><strong>An administrator uploads a PDF</strong></div>
              <div class="stat-row"><span>Step 2</span><strong>The file is assigned to you or all partners</strong></div>
              <div class="stat-row"><span>Step 3</span><strong>You download it through this portal</strong></div>
            </div>
          </article>
          <article class="panel">
            <div class="panel-head"><div><h2>Need a file?</h2><p>Request a report or agreement from the project team.</p></div></div>
            <button class="button button-secondary button-full" type="button" data-go="messages">Send a document request</button>
          </article>
        </aside>
      </section>`;
  }

  function messagesPage() {
    const messages = state.messages || [];
    const isAdmin = state.me?.role === 'admin';
    const clients = (state.admin?.users || []).filter((user) => user.role === 'user');

    return `${pageHeading('Messages', isAdmin ? 'Review messages submitted by client partners.' : 'Contact the Intercoastal Water LLC project support team.')}
      <section class="message-layout">
        <article class="panel">
          <div class="panel-head"><div><h2>${isAdmin ? 'Client inbox' : 'Your conversation'}</h2><p>${messages.length ? `${pluralise(messages.length, 'message')} available` : 'No messages yet.'}</p></div></div>
          <div class="message-list">${messages.length ? messages.map((message) => `
            <article class="message-item">
              <strong>${escapeHtml(message.subject)}</strong>
              <span>${escapeHtml(message.senderName || 'Project support')} · ${escapeHtml(dateLabel(message.createdAt))}</span>
              <p>${escapeHtml(message.message)}</p>
            </article>`).join('') : '<div class="empty-state"><div><strong>No messages yet</strong><p>Send a question to the project support team and it appears here.</p></div></div>'}</div>
        </article>
        <article class="panel">
          <div class="panel-head"><div><h2>${isAdmin ? 'Send a project update' : 'Send a message'}</h2><p>${isAdmin ? 'Messages can be sent to all portal users or one client.' : 'Your message goes securely to project administration.'}</p></div></div>
          <form id="message-form" class="form-stack">
            <label>Subject<input name="subject" maxlength="120" placeholder="How can we help?" required></label>
            ${isAdmin ? `<label>Recipient<select name="recipientId"><option value="all">All portal users</option>${clients.map((user) => `<option value="${escapeHtml(user.id)}">${escapeHtml(user.name)} · ${escapeHtml(user.email)}</option>`).join('')}</select></label>` : ''}
            <label>Message<textarea name="message" maxlength="2000" placeholder="Write your message here…" required></textarea></label>
            <p class="form-note">Please do not include banking details or other sensitive information in portal messages.</p>
            <button class="button button-primary" type="submit">Send message</button>
          </form>
        </article>
      </section>`;
  }

  function profilePage() {
    const profile = state.me?.profile || {};
    const name = profile.name || state.me?.email || 'Portal user';

    return `${pageHeading('My profile', 'Keep your contact details current for project communications.')}
      <section class="profile-grid">
        <article class="panel profile-summary">
          <div class="large-avatar" aria-hidden="true">${escapeHtml(initials(name))}</div>
          <h2>${escapeHtml(name)}</h2>
          <p>${escapeHtml(state.me?.email || '')}</p>
          <span class="pill profile-role">${state.me?.role === 'admin' ? 'Administrator' : 'Client partner'}</span>
          <p class="form-note u-mt-24">Your role and investment record are maintained by Intercoastal Water LLC.</p>
        </article>
        <article class="panel">
          <div class="panel-head"><div><h2>Contact information</h2><p>Used for portal communications and account identification.</p></div></div>
          <form id="profile-form">
            <div class="form-grid">
              <label class="field">Full name<input name="name" maxlength="80" value="${escapeHtml(profile.name || '')}" required></label>
              <label class="field">Organisation<input name="company" maxlength="100" value="${escapeHtml(profile.company || '')}" placeholder="Organisation or company"></label>
              <label class="field">Phone number<input name="phone" type="tel" inputmode="tel" maxlength="40" value="${escapeHtml(profile.phone || '')}" placeholder="Optional"></label>
              <label class="field">Location<input name="location" maxlength="100" value="${escapeHtml(profile.location || '')}" placeholder="City, country or region"></label>
              <label class="field field-full">Account email<input value="${escapeHtml(state.me?.email || '')}" disabled aria-describedby="email-note"></label>
            </div>
            <p class="form-note u-mt-12" id="email-note">Email changes require help from project support.</p>
            <div class="form-actions"><button class="button button-primary" type="submit">Save profile</button></div>
          </form>
        </article>
      </section>`;
  }

  const STAGE_STATUS_LABELS = { complete: 'Completed', current: 'In progress', upcoming: 'Upcoming' };

  function stageRows() {
    const stages = state.stageDraft || [];
    if (!stages.length) return '<p class="form-note">No milestones yet. Add the first one below.</p>';
    return stages.map((stage, index) => `
      <div class="stage-row" data-stage-index="${index}">
        <span class="stage-number" aria-hidden="true">${index + 1}</span>
        <input name="stageName" maxlength="80" placeholder="Milestone name" aria-label="Milestone ${index + 1} name" value="${escapeHtml(stage.name || '')}">
        <select name="stageStatus" aria-label="Milestone ${index + 1} status">
          ${Object.entries(STAGE_STATUS_LABELS).map(([value, label]) => `<option value="${value}"${stage.status === value ? ' selected' : ''}>${label}</option>`).join('')}
        </select>
        <input name="stageDate" maxlength="40" placeholder="Sep 2026" aria-label="Milestone ${index + 1} date" value="${escapeHtml(stage.date || '')}">
        <button class="icon-button stage-remove" type="button" data-remove-stage="${index}" aria-label="Remove milestone ${index + 1}">&times;</button>
      </div>`).join('');
  }

  function adminPage() {
    const project = projectData();
    const admin = state.admin || { users: [], documentCount: 0, messageCount: 0 };
    const clients = (admin.users || []).filter((user) => user.role === 'user');
    const firstClient = clients[0];
    const clientOptions = clients.map((user) => `<option value="${escapeHtml(user.id)}">${escapeHtml(user.name)} · ${escapeHtml(user.email)}</option>`).join('');
    const currentStage = (state.stageDraft || []).find((stage) => stage.status === 'current');

    return `${pageHeading('Administration', 'Everything clients see on their dashboard is set here.')}
      <div class="admin-tabs">
        <div class="admin-stat"><strong>${clients.length}</strong>Client accounts</div>
        <div class="admin-stat"><strong>${toNumber(admin.documentCount)}</strong>Uploaded PDFs</div>
        <div class="admin-stat"><strong>${toNumber(admin.messageCount)}</strong>Portal messages</div>
      </div>

      <div class="stack">
        <article class="panel">
          <div class="panel-head"><div><h2>Project figures</h2><p>These four numbers drive the cards at the top of every client dashboard.</p></div></div>
          <form id="project-admin-form" class="form-grid">
            <label class="field">Total project value (USD)
              <input type="number" name="totalProjectValue" min="0" step="1000" inputmode="numeric" value="${escapeHtml(toNumber(project.totalProjectValue))}" required>
              <span class="form-note">Shown as ${compactMoney(project.totalProjectValue)}</span>
            </label>
            <label class="field">Estimated project cost (USD)
              <input type="number" name="estimatedProjectCost" min="0" step="1000" inputmode="numeric" value="${escapeHtml(toNumber(project.estimatedProjectCost))}" required>
              <span class="form-note">Shown as ${compactMoney(project.estimatedProjectCost)}. The percentage of contracted value is calculated for you.</span>
            </label>
            <label class="field">Project progress (%)
              <input type="number" name="projectProgress" min="0" max="100" step="0.1" inputmode="decimal" value="${escapeHtml(toNumber(project.projectProgress))}" required>
              <span class="form-note">Drives the progress card, the donut and the timeline bar.</span>
            </label>
            <label class="field">Project status
              <input name="status" maxlength="80" value="${escapeHtml(project.status || '')}" required>
              <span class="form-note">Fallback for the current-phase card${currentStage ? `, which currently reads “${escapeHtml(currentStage.name)}” from the timeline below` : ''}.</span>
            </label>
            <label class="field">Location
              <input name="location" maxlength="120" value="${escapeHtml(project.location || '')}" placeholder="Coastal service district">
            </label>
            <label class="field">Operating capacity
              <input name="capacity" maxlength="120" value="${escapeHtml(project.capacity || '')}" placeholder="12 MW / 8 MLD">
            </label>
            <div class="form-actions field-full"><button class="button button-primary" type="submit">Save project figures</button></div>
          </form>
        </article>

        <article class="panel">
          <div class="panel-head">
            <div><h2>Project timeline</h2><p>Each row is one milestone. The row marked “In progress” becomes the current phase on the dashboard.</p></div>
          </div>
          <form id="timeline-admin-form">
            <div class="stage-editor" id="stage-rows">${stageRows()}</div>
            <div class="stage-actions">
              <button class="button button-secondary" type="button" data-add-stage>Add milestone</button>
              <button class="button button-primary" type="submit">Save timeline</button>
            </div>
          </form>
        </article>

        <article class="panel">
          <div class="panel-head"><div><h2>Add a new user</h2><p>Create a portal login for a new client partner or administrator.</p></div></div>
          <form id="new-user-form" class="form-stack">
            <label>Full name<input name="name" maxlength="80" placeholder="Jordan Ellis" required></label>
            <label>Email address<input name="email" type="email" autocomplete="off" inputmode="email" autocapitalize="none" spellcheck="false" placeholder="jordan@company.com" required></label>
            <label>Temporary password<input name="password" type="password" autocomplete="new-password" minlength="8" placeholder="At least 8 characters" required></label>
            <label>Role
              <select name="role">
                <option value="user" selected>Client partner</option>
                <option value="admin">Administrator</option>
              </select>
            </label>
            <span class="form-note">Share this password with them directly — it is not emailed automatically. Ask them to change it after their first sign-in.</span>
            <div class="form-actions"><button class="button button-primary" type="submit">Create account</button></div>
          </form>
        </article>

        <article class="panel">
          <div class="panel-head"><div><h2>Clients</h2><p>Set what one client has invested, and send them a PDF.</p></div></div>
          ${clients.length ? `
            <form id="investment-admin-form" class="form-stack">
              <label>Client<select name="userId">${clientOptions}</select></label>
              <label>Investment amount (USD)<input type="number" name="investment" min="0" step="1000" inputmode="numeric" value="${escapeHtml(toNumber(firstClient?.investment))}" required></label>
              <span class="form-note">Only this client sees this figure. Their ownership share is calculated from the total project value.</span>
              <div class="form-actions"><button class="button button-primary" type="submit">Save investment</button></div>
            </form>

            <hr class="panel-divider">

            <form id="upload-form" class="form-stack" enctype="multipart/form-data">
              <label>Send to<select name="audience"><option value="all">All portal users</option>${clientOptions}</select></label>
              <label>Document title<input name="title" maxlength="140" placeholder="September progress report" required></label>
              <label>Short description<input name="description" maxlength="300" placeholder="Optional context for the client"></label>
              <label class="upload-zone">PDF file<input type="file" name="file" accept="application/pdf,.pdf" required></label>
              <span class="form-note">PDF only, up to 10 MB. A file sent to one client is visible only to that client.</span>
              <div class="form-actions"><button class="button button-primary" type="submit">Upload and send</button></div>
            </form>` : '<div class="empty-state"><div><strong>No client accounts yet</strong><p>Add one above, then come back to record their investment.</p></div></div>'}
        </article>

        <article class="panel">
          <div class="panel-head"><div><h2>Uploaded documents</h2><p>Everything shared through the portal. Deleting a file removes it for everyone it was shared with.</p></div>${state.adminDocumentsUnavailable ? '' : `<span class="pill gray">${pluralise((state.adminDocuments || []).length, 'file')}</span>`}</div>
          ${state.adminDocumentsUnavailable
            ? '<div class="empty-state"><div><strong>This panel isn\u2019t connected yet</strong><p>It needs a GET /api/admin/documents endpoint (and DELETE /api/admin/documents/:id to remove a file) on the server.</p></div></div>'
            : adminDocumentRows(state.adminDocuments, clients)}
        </article>
      </div>`;
  }

  function renderCurrentPage() {
    const renderer = {
      dashboard: dashboardPage,
      investment: investmentPage,
      project: projectPage,
      financials: financialsPage,
      documents: documentsPage,
      messages: messagesPage,
      profile: profilePage,
      admin: adminPage
    }[state.page] || dashboardPage;
    content.innerHTML = renderer();
  }

  /* ---------------------------------------------------------------------
     Form handlers
     --------------------------------------------------------------------- */

  function handleFormError(error) {
    if (error.status === 401) signOutLocally('Your session has ended. Please sign in again.');
    else showToast(error.message, true);
  }

  async function submitProfile(form) {
    const button = form.querySelector('button[type="submit"]');
    setButtonBusy(button, true, 'Saving…');
    try {
      const data = await api('/api/profile', { method: 'PATCH', json: Object.fromEntries(new FormData(form)) });
      state.me = data.user;
      if (state.dashboard) state.dashboard.user = data.user;
      setTopBar();
      renderCurrentPage();
      showToast('Profile saved.');
    } catch (error) {
      handleFormError(error);
    } finally {
      setButtonBusy(button, false);
    }
  }

  async function submitMessage(form) {
    const button = form.querySelector('button[type="submit"]');
    setButtonBusy(button, true, 'Sending…');
    try {
      await api('/api/messages', { method: 'POST', json: Object.fromEntries(new FormData(form)) });
      state.messages = (await api('/api/messages')).messages || [];
      renderCurrentPage();
      showToast('Message sent.');
    } catch (error) {
      handleFormError(error);
    } finally {
      setButtonBusy(button, false);
    }
  }

  function cloneStages(stages) {
    return (stages || []).map((stage) => ({
      name: stage.name || '',
      status: stage.status || 'upcoming',
      date: stage.date || ''
    }));
  }

  function renderStageRows() {
    const container = content.querySelector('#stage-rows');
    if (container) container.innerHTML = stageRows();
  }

  /* Exactly one milestone can be in progress: it is what the dashboard shows
     as the current phase. Setting a new one demotes the old. */
  function setStageStatus(index, status) {
    const stages = state.stageDraft || [];
    stages[index].status = status;
    if (status !== 'current') return false;
    let changedOthers = false;
    stages.forEach((stage, position) => {
      if (position === index || stage.status !== 'current') return;
      stage.status = position < index ? 'complete' : 'upcoming';
      changedOthers = true;
    });
    return changedOthers;
  }

  async function submitTimelineAdmin(form) {
    const stages = (state.stageDraft || [])
      .map((stage) => ({ ...stage, name: stage.name.trim(), date: stage.date.trim() }))
      .filter((stage) => stage.name);

    if (!stages.length) {
      showToast('Add at least one milestone with a name.', true);
      return;
    }

    const button = form.querySelector('button[type="submit"]');
    setButtonBusy(button, true, 'Saving…');
    try {
      const data = await api('/api/admin/project', { method: 'PATCH', json: { stages } });
      if (state.dashboard && data?.project) state.dashboard.project = data.project;
      else await loadDashboard();
      state.stageDraft = cloneStages(projectData().stages);
      renderCurrentPage();
      showToast('Timeline saved.');
    } catch (error) {
      handleFormError(error);
    } finally {
      setButtonBusy(button, false);
    }
  }

  async function submitProjectAdmin(form) {
    const button = form.querySelector('button[type="submit"]');
    setButtonBusy(button, true, 'Saving…');
    try {
      const data = await api('/api/admin/project', { method: 'PATCH', json: Object.fromEntries(new FormData(form)) });
      if (state.dashboard && data?.project) state.dashboard.project = data.project;
      else await loadDashboard();
      if (state.page === 'admin') state.stageDraft = cloneStages(projectData().stages);
      renderCurrentPage();
      showToast('Project figures saved.');
    } catch (error) {
      handleFormError(error);
    } finally {
      setButtonBusy(button, false);
    }
  }

  async function submitInvestmentAdmin(form) {
    const button = form.querySelector('button[type="submit"]');
    const values = Object.fromEntries(new FormData(form));
    setButtonBusy(button, true, 'Saving…');
    try {
      await api(`/api/admin/users/${encodeURIComponent(values.userId)}/investment`, {
        method: 'PATCH',
        json: { investment: values.investment }
      });
      state.admin = await api('/api/admin/summary');
      renderCurrentPage();
      showToast('Client investment saved.');
    } catch (error) {
      handleFormError(error);
    } finally {
      setButtonBusy(button, false);
    }
  }

  async function submitUpload(form) {
    const button = form.querySelector('button[type="submit"]');
    const fileField = form.querySelector('input[type="file"]');
    const file = fileField?.files?.[0];

    if (!file) {
      showToast('Choose a PDF to upload.', true);
      fileField?.focus();
      return;
    }
    const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
    if (!isPdf) {
      showToast('That file is not a PDF. Choose a PDF file.', true);
      fileField.focus();
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      showToast('That file is larger than 10 MB. Compress it and try again.', true);
      fileField.focus();
      return;
    }

    setButtonBusy(button, true, 'Uploading…');
    try {
      await api('/api/admin/documents', { method: 'POST', body: new FormData(form) });
      state.admin = await api('/api/admin/summary');
      await loadAdminDocuments();
      form.reset();
      renderCurrentPage();
      showToast('PDF uploaded and shared.');
    } catch (error) {
      handleFormError(error);
    } finally {
      setButtonBusy(button, false);
    }
  }

  async function deleteAdminDocument(id, title, button) {
    if (!window.confirm(`Delete "${title}"? This removes it for everyone it was shared with. This cannot be undone.`)) return;
    setButtonBusy(button, true, '…');
    try {
      await api(`/api/admin/documents/${encodeURIComponent(id)}`, { method: 'DELETE' });
      state.admin = await api('/api/admin/summary');
      await loadAdminDocuments();
      renderCurrentPage();
      showToast('Document deleted.');
    } catch (error) {
      handleFormError(error);
    } finally {
      setButtonBusy(button, false);
    }
  }

  async function submitNewUser(form) {
    const button = form.querySelector('button[type="submit"]');
    setButtonBusy(button, true, 'Creating…');
    try {
      await api('/api/admin/users', { method: 'POST', json: Object.fromEntries(new FormData(form)) });
      state.admin = await api('/api/admin/summary');
      form.reset();
      renderCurrentPage();
      showToast('New account created.');
    } catch (error) {
      handleFormError(error);
    } finally {
      setButtonBusy(button, false);
    }
  }

  /* ---------------------------------------------------------------------
     Events
     --------------------------------------------------------------------- */

  loginForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!loginForm.reportValidity()) return;
    const button = loginForm.querySelector('button[type="submit"]');
    setButtonBusy(button, true, 'Signing in…');
    setAuthError();
    try {
      const data = await api('/api/auth/login', { method: 'POST', json: Object.fromEntries(new FormData(loginForm)) });
      state.me = data.user;
      await launchPortal();
    } catch (error) {
      setAuthError(error.message);
    } finally {
      setButtonBusy(button, false);
    }
  });

  document.addEventListener('click', async (event) => {
    if (event.target.closest('[data-add-stage]')) {
      state.stageDraft = state.stageDraft || [];
      state.stageDraft.push({ name: '', status: 'upcoming', date: '' });
      renderStageRows();
      content.querySelector('.stage-row:last-child input')?.focus();
      return;
    }

    const removeStage = event.target.closest('[data-remove-stage]');
    if (removeStage && state.stageDraft) {
      state.stageDraft.splice(Number(removeStage.dataset.removeStage), 1);
      renderStageRows();
      return;
    }

    const deleteDocButton = event.target.closest('[data-delete-document]');
    if (deleteDocButton) {
      await deleteAdminDocument(
        deleteDocButton.dataset.deleteDocument,
        deleteDocButton.dataset.documentTitle || 'this document',
        deleteDocButton
      );
      return;
    }

    const pageButton = event.target.closest('[data-page], [data-go]');
    if (pageButton) {
      await navigate(pageButton.dataset.page || pageButton.dataset.go);
      return;
    }

    if (event.target.closest('[data-open-sidebar]')) { openMenu(); return; }
    if (event.target.closest('[data-close-sidebar]')) { closeMenu(true); return; }

    if (event.target.closest('[data-signout]')) {
      try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* a cleared session is still safe to end locally */ }
      signOutLocally();
      showToast('You have been signed out.');
    }
  });

  content.addEventListener('submit', (event) => {
    event.preventDefault();
    const form = event.target;
    if (!form.reportValidity()) return;
    if (form.id === 'profile-form') submitProfile(form);
    else if (form.id === 'message-form') submitMessage(form);
    else if (form.id === 'project-admin-form') submitProjectAdmin(form);
    else if (form.id === 'timeline-admin-form') submitTimelineAdmin(form);
    else if (form.id === 'investment-admin-form') submitInvestmentAdmin(form);
    else if (form.id === 'upload-form') submitUpload(form);
    else if (form.id === 'new-user-form') submitNewUser(form);
  });

  content.addEventListener('input', (event) => {
    const row = event.target.closest('.stage-row');
    if (!row || !state.stageDraft) return;
    const stage = state.stageDraft[Number(row.dataset.stageIndex)];
    if (!stage) return;
    if (event.target.name === 'stageName') stage.name = event.target.value;
    if (event.target.name === 'stageDate') stage.date = event.target.value;
  });

  content.addEventListener('change', (event) => {
    const stageRow = event.target.closest('.stage-row');
    if (stageRow && event.target.name === 'stageStatus' && state.stageDraft) {
      const index = Number(stageRow.dataset.stageIndex);
      if (setStageStatus(index, event.target.value)) renderStageRows();
      return;
    }
    if (event.target.name === 'userId' && event.target.closest('#investment-admin-form')) {
      const selected = state.admin?.users?.find((user) => user.id === event.target.value);
      const amountField = event.target.form?.querySelector('[name="investment"]');
      if (selected && amountField) {
        amountField.value = toNumber(selected.investment);
        amountField.defaultValue = amountField.value;
      }
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && portal.classList.contains('menu-open')) closeMenu(true);
  });

  document.addEventListener('focusout', () => {
    window.setTimeout(() => {
      if (pendingRealtimeChanges.size && !hasActiveEditor() && !hasUnsavedPortalChanges()) {
        queueRealtimeRefresh('deferred');
      }
    }, 0);
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.me) queueRealtimeRefresh('visibility');
  });

  window.addEventListener('hashchange', () => {
    if (suppressHashHandling || !state.me) return;
    navigate(pageFromHash());
  });

  /* The menu is a mobile pattern only; leaving that breakpoint resets it. */
  const desktopQuery = window.matchMedia('(min-width: 981px)');
  desktopQuery.addEventListener('change', (event) => { if (event.matches) closeMenu(); });

  window.addEventListener('pagehide', () => closeRealtimeConnection(false));

  (async () => {
    try {
      const data = await api('/api/auth/me');
      state.me = data.user;
      await launchPortal();
    } catch {
      resetAuthView();
    }
  })();
})();