'use strict';

function renderAppHtml() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>LLM Trace</title>
    <style>
      :root {
        --paper: #f6f0e8;
        --paper-strong: #fffaf3;
        --ink: #1f2a2a;
        --muted: #61706c;
        --accent: #0f766e;
        --accent-soft: rgba(15, 118, 110, 0.14);
        --line: rgba(31, 42, 42, 0.12);
        --warn: #b45309;
        --error: #b91c1c;
        --ok: #166534;
        --shadow: 0 18px 50px rgba(31, 42, 42, 0.08);
      }

      * {
        box-sizing: border-box;
      }

      html, body {
        margin: 0;
        min-height: 100%;
        background:
          radial-gradient(circle at top left, rgba(15, 118, 110, 0.18), transparent 22rem),
          radial-gradient(circle at top right, rgba(180, 83, 9, 0.12), transparent 18rem),
          linear-gradient(180deg, #efe4d6, var(--paper) 18rem, #efe7db);
        color: var(--ink);
        font-family: "Iowan Old Style", "Palatino Linotype", "Book Antiqua", Georgia, serif;
      }

      body {
        display: grid;
        grid-template-rows: auto 1fr;
      }

      header {
        padding: 1.2rem 1.5rem 1rem;
        border-bottom: 1px solid var(--line);
        background: rgba(255, 250, 243, 0.75);
        backdrop-filter: blur(14px);
        position: sticky;
        top: 0;
        z-index: 3;
      }

      .title-row {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 1rem;
      }

      h1 {
        margin: 0;
        font-size: 1.9rem;
        letter-spacing: -0.03em;
      }

      .subtitle {
        color: var(--muted);
        font-size: 0.95rem;
      }

      .toolbar {
        margin-top: 0.9rem;
        display: grid;
        grid-template-columns: minmax(12rem, 2fr) repeat(4, minmax(8rem, 1fr)) auto auto;
        gap: 0.75rem;
      }

      input, select, button {
        width: 100%;
        border-radius: 999px;
        border: 1px solid var(--line);
        background: rgba(255, 255, 255, 0.78);
        padding: 0.72rem 1rem;
        color: var(--ink);
        font: inherit;
      }

      button {
        cursor: pointer;
        transition: transform 140ms ease, background 140ms ease;
      }

      button:hover {
        transform: translateY(-1px);
        background: rgba(255, 255, 255, 0.96);
      }

      .accent {
        background: linear-gradient(135deg, var(--accent), #155e75);
        color: white;
        border-color: transparent;
      }

      main {
        display: grid;
        grid-template-columns: 23rem minmax(18rem, 28rem) 1fr;
        gap: 1rem;
        padding: 1rem 1.2rem 1.4rem;
        min-height: 0;
      }

      .panel {
        min-height: 0;
        border: 1px solid var(--line);
        border-radius: 1.2rem;
        background: rgba(255, 250, 243, 0.86);
        box-shadow: var(--shadow);
        overflow: hidden;
        display: flex;
        flex-direction: column;
        animation: fadeUp 180ms ease;
      }

      .panel h2 {
        margin: 0;
        font-size: 1rem;
        letter-spacing: 0.02em;
      }

      .panel-header {
        padding: 0.9rem 1rem;
        border-bottom: 1px solid var(--line);
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 0.5rem;
      }

      .panel-body {
        overflow: auto;
        padding: 0.8rem 1rem 1rem;
      }

      .tree, .trace-list {
        display: flex;
        flex-direction: column;
        gap: 0.35rem;
      }

      .tree-node, .trace-card {
        border: 1px solid transparent;
        border-radius: 1rem;
        padding: 0.65rem 0.8rem;
        background: rgba(255, 255, 255, 0.55);
        cursor: pointer;
        transition: background 140ms ease, border-color 140ms ease, transform 140ms ease;
      }

      .tree-node:hover, .trace-card:hover {
        transform: translateY(-1px);
        background: rgba(255, 255, 255, 0.8);
      }

      .tree-node.active, .trace-card.active {
        border-color: rgba(15, 118, 110, 0.35);
        background: var(--accent-soft);
      }

      .tree-children {
        margin-left: 1rem;
        padding-left: 0.85rem;
        border-left: 1px dashed rgba(31, 42, 42, 0.15);
        display: grid;
        gap: 0.35rem;
      }

      .label-row, .trace-head {
        display: flex;
        justify-content: space-between;
        gap: 0.8rem;
        align-items: center;
      }

      .node-type, .pill {
        display: inline-flex;
        align-items: center;
        padding: 0.18rem 0.55rem;
        border-radius: 999px;
        background: rgba(31, 42, 42, 0.08);
        color: var(--muted);
        font-size: 0.72rem;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      }

      .pill.ok {
        color: var(--ok);
      }

      .pill.error {
        color: var(--error);
      }

      .pill.pending {
        color: var(--warn);
      }

      .meta {
        color: var(--muted);
        font-size: 0.88rem;
      }

      .detail-grid {
        display: grid;
        gap: 1rem;
      }

      .section {
        border: 1px solid var(--line);
        border-radius: 1rem;
        background: rgba(255, 255, 255, 0.58);
        overflow: hidden;
      }

      .section h3 {
        margin: 0;
        padding: 0.7rem 0.9rem;
        border-bottom: 1px solid var(--line);
        font-size: 0.95rem;
      }

      .section-body {
        padding: 0.85rem 0.95rem;
      }

      .kv {
        display: grid;
        grid-template-columns: minmax(8rem, 12rem) 1fr;
        gap: 0.45rem 0.8rem;
        align-items: start;
      }

      .kv dt {
        color: var(--muted);
      }

      .kv dd {
        margin: 0;
        word-break: break-word;
      }

      .message, pre {
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      }

      .message {
        border: 1px solid rgba(31, 42, 42, 0.08);
        border-radius: 0.9rem;
        padding: 0.75rem 0.85rem;
        background: rgba(255, 255, 255, 0.7);
        margin-bottom: 0.65rem;
      }

      .message-role {
        margin-bottom: 0.45rem;
      }

      pre {
        margin: 0;
        white-space: pre-wrap;
        word-break: break-word;
        font-size: 0.82rem;
        line-height: 1.45;
      }

      .empty {
        color: var(--muted);
        padding: 1rem 0.1rem;
      }

      @keyframes fadeUp {
        from {
          opacity: 0;
          transform: translateY(6px);
        }

        to {
          opacity: 1;
          transform: translateY(0);
        }
      }

      @media (max-width: 1200px) {
        .toolbar {
          grid-template-columns: repeat(2, minmax(10rem, 1fr));
        }

        main {
          grid-template-columns: 1fr;
        }
      }
    </style>
  </head>
  <body>
    <header>
      <div class="title-row">
        <div>
          <h1>LLM Trace</h1>
          <div class="subtitle">Hierarchy-first tracing for local ai-api development.</div>
        </div>
        <div id="stats" class="subtitle"></div>
      </div>
      <div class="toolbar">
        <input id="search" type="search" placeholder="Search prompts, responses, tags" />
        <input id="tags" type="text" placeholder="Tags (agentId:test,kind:watchdog)" />
        <select id="status">
          <option value="">All statuses</option>
          <option value="pending">Pending</option>
          <option value="ok">OK</option>
          <option value="error">Error</option>
        </select>
        <select id="kind">
          <option value="">All kinds</option>
          <option value="agent">Agent</option>
          <option value="delegated-agent">Delegated agent</option>
          <option value="workflow-state">Workflow state</option>
          <option value="watchdog">Watchdog</option>
        </select>
        <select id="groupBy">
          <option value="">Hierarchy view</option>
          <option value="agentId">Group by agent</option>
          <option value="chatId">Group by chat</option>
          <option value="userId">Group by user</option>
          <option value="model">Group by model</option>
          <option value="kind">Group by kind</option>
        </select>
        <button id="toggleView">Raw JSON</button>
        <button id="clear" class="accent">Clear traces</button>
      </div>
    </header>
    <main>
      <section class="panel">
        <div class="panel-header">
          <h2>Hierarchy</h2>
          <span id="treeCount" class="meta"></span>
        </div>
        <div class="panel-body">
          <div id="tree" class="tree"></div>
        </div>
      </section>
      <section class="panel">
        <div class="panel-header">
          <h2>Trace Timeline</h2>
          <span id="listCount" class="meta"></span>
        </div>
        <div class="panel-body">
          <div id="traceList" class="trace-list"></div>
        </div>
      </section>
      <section class="panel">
        <div class="panel-header">
          <h2>Detail</h2>
          <span id="detailMeta" class="meta"></span>
        </div>
        <div class="panel-body">
          <div id="detail"></div>
        </div>
      </section>
    </main>
    <script>
      const state = {
        viewMode: 'formatted',
        selectedNodeId: null,
        selectedTraceId: null,
        traces: [],
        hierarchy: [],
      };

      const els = {
        search: document.getElementById('search'),
        tags: document.getElementById('tags'),
        status: document.getElementById('status'),
        kind: document.getElementById('kind'),
        groupBy: document.getElementById('groupBy'),
        toggleView: document.getElementById('toggleView'),
        clear: document.getElementById('clear'),
        tree: document.getElementById('tree'),
        traceList: document.getElementById('traceList'),
        detail: document.getElementById('detail'),
        stats: document.getElementById('stats'),
        treeCount: document.getElementById('treeCount'),
        listCount: document.getElementById('listCount'),
        detailMeta: document.getElementById('detailMeta'),
      };

      function filtersToQuery() {
        const params = new URLSearchParams();
        if (els.search.value) params.set('search', els.search.value);
        if (els.tags.value) params.set('tags', els.tags.value);
        if (els.status.value) params.set('status', els.status.value);
        if (els.kind.value) params.set('kind', els.kind.value);
        if (els.groupBy.value) params.set('groupBy', els.groupBy.value);
        return params.toString();
      }

      function escapeHtml(value) {
        return String(value ?? '')
          .replaceAll('&', '&amp;')
          .replaceAll('<', '&lt;')
          .replaceAll('>', '&gt;')
          .replaceAll('"', '&quot;');
      }

      function prettyJson(value) {
        return escapeHtml(JSON.stringify(value, null, 2));
      }

      async function load() {
        const query = filtersToQuery();
        const [tracesRes, hierarchyRes] = await Promise.all([
          fetch('/api/traces' + (query ? '?' + query : '')),
          fetch('/api/hierarchy' + (query ? '?' + query : '')),
        ]);

        const tracesPayload = await tracesRes.json();
        const hierarchyPayload = await hierarchyRes.json();

        state.traces = tracesPayload.items;
        state.hierarchy = hierarchyPayload.rootNodes;

        if (!state.selectedNodeId && state.hierarchy[0]) {
          state.selectedNodeId = state.hierarchy[0].id;
        }

        const visibleTraceIds = getVisibleTraceIds();
        if (!state.selectedTraceId || !visibleTraceIds.includes(state.selectedTraceId)) {
          state.selectedTraceId = visibleTraceIds[0] || null;
        }

        renderAll(tracesPayload, hierarchyPayload);
        await loadDetail();
      }

      function renderAll(tracesPayload, hierarchyPayload) {
        els.stats.textContent = tracesPayload.filtered + ' / ' + tracesPayload.total + ' traces';
        els.treeCount.textContent = hierarchyPayload.filtered + ' visible';
        els.listCount.textContent = getVisibleTraceIds().length + ' traces';
        renderTree();
        renderTraceList();
      }

      function getVisibleTraceIds() {
        if (!state.selectedNodeId) {
          return state.traces.map((item) => item.id);
        }

        const node = findNode(state.hierarchy, state.selectedNodeId);
        if (!node) {
          return state.traces.map((item) => item.id);
        }

        return node.traceIds || [];
      }

      function renderTree() {
        if (state.hierarchy.length === 0) {
          els.tree.innerHTML = '<div class="empty">No traces yet.</div>';
          return;
        }

        els.tree.innerHTML = state.hierarchy.map((node) => renderNode(node)).join('');
        els.tree.querySelectorAll('[data-node-id]').forEach((el) => {
          el.addEventListener('click', (event) => {
            const id = event.currentTarget.getAttribute('data-node-id');
            state.selectedNodeId = id;
            const visible = getVisibleTraceIds();
            state.selectedTraceId = visible[0] || null;
            renderTraceList();
            renderTree();
            loadDetail();
          });
        });
      }

      function renderNode(node) {
        const activeClass = state.selectedNodeId === node.id ? 'active' : '';
        const children = (node.children || []).map((child) => renderNode(child)).join('');
        return \`
          <div>
            <div class="tree-node \${activeClass}" data-node-id="\${escapeHtml(node.id)}">
              <div class="label-row">
                <strong>\${escapeHtml(node.label)}</strong>
                <span class="node-type">\${escapeHtml(node.type)}</span>
              </div>
              <div class="meta">\${node.count} trace\${node.count === 1 ? '' : 's'}</div>
            </div>
            \${children ? '<div class="tree-children">' + children + '</div>' : ''}
          </div>
        \`;
      }

      function renderTraceList() {
        const traceIds = new Set(getVisibleTraceIds());
        const items = state.traces.filter((item) => traceIds.has(item.id));
        els.listCount.textContent = items.length + ' traces';

        if (items.length === 0) {
          els.traceList.innerHTML = '<div class="empty">No traces match this selection.</div>';
          return;
        }

        els.traceList.innerHTML = items.map((item) => {
          const activeClass = state.selectedTraceId === item.id ? 'active' : '';
          const statusClass = item.status || 'pending';
          const title = item.model || item.id;
          const preview = item.responsePreview || item.requestPreview || '';
          const meta = [item.kind, item.mode, item.durationMs == null ? 'running' : item.durationMs + ' ms'].filter(Boolean).join(' · ');
          return \`
            <div class="trace-card \${activeClass}" data-trace-id="\${escapeHtml(item.id)}">
              <div class="trace-head">
                <strong>\${escapeHtml(title)}</strong>
                <span class="pill \${escapeHtml(statusClass)}">\${escapeHtml(item.status)}</span>
              </div>
              <div class="meta">\${escapeHtml(meta)}</div>
              <div class="meta">\${escapeHtml(preview)}</div>
            </div>
          \`;
        }).join('');

        els.traceList.querySelectorAll('[data-trace-id]').forEach((el) => {
          el.addEventListener('click', (event) => {
            state.selectedTraceId = event.currentTarget.getAttribute('data-trace-id');
            renderTraceList();
            loadDetail();
          });
        });
      }

      async function loadDetail() {
        if (!state.selectedTraceId) {
          els.detailMeta.textContent = '';
          els.detail.innerHTML = '<div class="empty">Select a trace to inspect it.</div>';
          return;
        }

        const res = await fetch('/api/traces/' + encodeURIComponent(state.selectedTraceId));
        if (res.status === 404) {
          els.detail.innerHTML = '<div class="empty">The selected trace is no longer available.</div>';
          return;
        }

        const trace = await res.json();
        els.detailMeta.textContent = trace.id;
        els.detail.innerHTML = state.viewMode === 'raw' ? renderRaw(trace) : renderFormatted(trace);
      }

      function renderFormatted(trace) {
        const messages = trace.request?.input?.messages || [];
        const tools = trace.request?.input?.tools || [];
        const sections = [];

        sections.push(renderKeyValueSection('Hierarchy', {
          kind: trace.kind,
          provider: trace.provider,
          model: trace.model,
          chatId: trace.context?.chatId,
          rootChatId: trace.context?.rootChatId,
          topLevelAgentId: trace.context?.topLevelAgentId,
          agentId: trace.context?.agentId,
          workflowState: trace.context?.workflowState,
          systemType: trace.context?.systemType,
          watchdogPhase: trace.context?.watchdogPhase,
        }));

        sections.push(renderKeyValueSection('Timing', {
          startedAt: trace.startedAt,
          endedAt: trace.endedAt || 'in progress',
          status: trace.status,
          chunkCount: trace.stream?.chunkCount,
          firstChunkMs: trace.stream?.firstChunkMs,
        }));

        sections.push(renderKeyValueSection('Tags', trace.tags || {}));

        sections.push(renderMessagesSection('Request Messages', messages));

        if (tools.length > 0) {
          sections.push(renderJsonSection('Tools', tools));
        }

        if (trace.mode === 'stream') {
          sections.push(renderJsonSection('Stream Reconstruction', trace.stream?.reconstructed));
          sections.push(renderJsonSection('Stream Chunks', trace.stream?.events || []));
        }

        sections.push(renderJsonSection('Response', trace.response));

        if (trace.error) {
          sections.push(renderJsonSection('Error', trace.error));
        }

        return '<div class="detail-grid">' + sections.join('') + '</div>';
      }

      function renderRaw(trace) {
        return '<div class="section"><h3>Raw JSON</h3><div class="section-body"><pre>' + prettyJson(trace) + '</pre></div></div>';
      }

      function renderKeyValueSection(title, record) {
        const entries = Object.entries(record || {}).filter(([, value]) => value !== undefined && value !== null && value !== '');
        if (entries.length === 0) {
          return '';
        }

        const body = entries.map(([key, value]) => '<dt>' + escapeHtml(key) + '</dt><dd>' + escapeHtml(value) + '</dd>').join('');
        return '<div class="section"><h3>' + escapeHtml(title) + '</h3><div class="section-body"><dl class="kv">' + body + '</dl></div></div>';
      }

      function renderMessagesSection(title, messages) {
        if (!messages || messages.length === 0) {
          return '';
        }

        const body = messages.map((message) => {
          return '<div class="message"><div class="message-role"><span class="pill">' + escapeHtml(message.role) + '</span></div><pre>' + prettyJson(message.content) + '</pre></div>';
        }).join('');

        return '<div class="section"><h3>' + escapeHtml(title) + '</h3><div class="section-body">' + body + '</div></div>';
      }

      function renderJsonSection(title, value) {
        if (value === undefined || value === null || (Array.isArray(value) && value.length === 0)) {
          return '';
        }

        return '<div class="section"><h3>' + escapeHtml(title) + '</h3><div class="section-body"><pre>' + prettyJson(value) + '</pre></div></div>';
      }

      function findNode(nodes, id) {
        for (const node of nodes) {
          if (node.id === id) {
            return node;
          }

          const child = findNode(node.children || [], id);
          if (child) {
            return child;
          }
        }

        return null;
      }

      function bindControls() {
        for (const el of [els.search, els.tags, els.status, els.kind, els.groupBy]) {
          el.addEventListener('input', debounce(load, 160));
          el.addEventListener('change', load);
        }

        els.toggleView.addEventListener('click', async () => {
          state.viewMode = state.viewMode === 'formatted' ? 'raw' : 'formatted';
          els.toggleView.textContent = state.viewMode === 'formatted' ? 'Raw JSON' : 'Formatted';
          await loadDetail();
        });

        els.clear.addEventListener('click', async () => {
          await fetch('/api/traces', { method: 'DELETE' });
        });
      }

      function debounce(fn, wait) {
        let timeout;
        return (...args) => {
          clearTimeout(timeout);
          timeout = setTimeout(() => fn(...args), wait);
        };
      }

      function connectEvents() {
        const events = new EventSource('/api/events');
        events.onmessage = () => load();
      }

      bindControls();
      load();
      connectEvents();
    </script>
  </body>
</html>`;
}

module.exports = {
  renderAppHtml,
};
