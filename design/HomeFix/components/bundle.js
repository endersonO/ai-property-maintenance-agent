/* @ds-bundle: {"format":4,"namespace":"HomeFix","components":[{"name":"Button"},{"name":"Select"},{"name":"Textarea"},{"name":"PriorityBadge"},{"name":"OutcomeBadge"},{"name":"ReviewBadge"},{"name":"TicketStatus"},{"name":"ChatBubble"},{"name":"ChatLog"},{"name":"EmergencyNotice"},{"name":"Composer"},{"name":"TicketCard"},{"name":"TicketList"},{"name":"TenantSwitcher"},{"name":"PipelineStages"},{"name":"JsonBlock"},{"name":"TimelineEvent"},{"name":"RunsTable"},{"name":"PassRate"},{"name":"Icon"}]} */
(function () {
  var React = window.React, h = React.createElement, F = React.Fragment;
  var useState = React.useState, useRef = React.useRef, useEffect = React.useEffect, useId = React.useId;
  function cx() { return Array.prototype.filter.call(arguments, Boolean).join(' '); }

  /* ---------- formatting (en-GB, GBP) ---------- */
  function fmtDate(d, opts) {
    var date = d instanceof Date ? d : new Date(d);
    return new Intl.DateTimeFormat('en-GB', opts || { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
  }
  function fmtTime(d) { return fmtDate(d, { hour: '2-digit', minute: '2-digit' }); }
  function fmtGBP(n, digits) { var dg = digits == null ? 2 : digits; return new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', minimumFractionDigits: dg, maximumFractionDigits: dg }).format(n); }
  function fmtInt(n) { return new Intl.NumberFormat('en-GB').format(n); }
  function fmtMs(ms) { return ms >= 1000 ? (ms / 1000).toFixed(1) + ' s' : fmtInt(ms) + ' ms'; }

  /* ---------- icons: 24 grid, 1.75 stroke ---------- */
  var P = {
    alert: ['M12 3.5 2.8 19.5h18.4z', 'M12 10v4', 'M12 17h.01'],
    alertFill: null,
    shield: ['M12 3 4.5 6v5.5c0 4.4 3.1 8.1 7.5 9.5 4.4-1.4 7.5-5.1 7.5-9.5V6z', 'M9 12h6'],
    person: ['M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'M4.5 20.5c1.2-3.5 4-5 7.5-5s6.3 1.5 7.5 5'],
    check: ['M5 12.5 10 17.5 19 7'],
    x: ['M6 6l12 12', 'M18 6 6 18'],
    clock: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 7v5l3 2'],
    tool: ['M14.5 6.5a4 4 0 0 0-5.3 5.3L3.5 17.5l3 3 5.7-5.7a4 4 0 0 0 5.3-5.3l-2.5 2.5-2.5-.5-.5-2.5z'],
    cpu: ['M7 7h10v10H7z', 'M10 10h4v4h-4z', 'M9 3v4M15 3v4M9 17v4M15 17v4M3 9h4M3 15h4M17 9h4M17 15h4'],
    chevron: ['M9 6l6 6-6 6'],
    send: ['M4 12 20 4l-6 16-3-7z', 'M11 13 20 4'],
    home: ['M4 11 12 4l8 7', 'M6 9.5V20h12V9.5']
  };
  function Icon(props) {
    var name = props.name, cls = cx('lo-icon', props.size === 'sm' && 'lo-icon-sm', props.className);
    if (name === 'alertFill') {
      return h('svg', { className: cls, viewBox: '0 0 24 24', 'aria-hidden': 'true' },
        h('path', { d: 'M12 2.5 1.8 20.5h20.4z', fill: 'currentColor' }),
        h('path', { d: 'M12 9.5v4.5M12 17.2h.01', stroke: 'var(--surface)', strokeWidth: 2.2, strokeLinecap: 'round' }));
    }
    return h('svg', { className: cls, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.75, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
      (P[name] || []).map(function (d, i) { return h('path', { key: i, d: d }); }));
  }

  /* ---------- Button ---------- */
  function Button(props) {
    var variant = props.variant || 'primary', pending = props.pending;
    var rest = Object.assign({}, props);
    ['variant', 'pending', 'pendingLabel', 'size', 'icon', 'forceState', 'children', 'className'].forEach(function (k) { delete rest[k]; });
    return h('button', Object.assign({ type: 'button' }, rest, {
      className: cx('lo-btn', 'lo-btn-' + variant, props.size === 'sm' && 'lo-btn-sm', props.forceState && 'is-' + props.forceState, props.className),
      disabled: props.disabled || pending, 'aria-busy': pending ? 'true' : undefined
    }),
      pending ? h('span', { className: 'lo-spinner', 'aria-hidden': 'true' }) : (props.icon ? h(Icon, { name: props.icon }) : null),
      pending ? (props.pendingLabel || props.children) : props.children);
  }

  /* ---------- Field wrapper ---------- */
  function Field(p, control) {
    return h('div', { className: 'lo-field' },
      p.label ? h('label', { className: p.hideLabel ? 'lo-sr' : 'lo-label', htmlFor: p.id }, p.label) : null,
      control,
      p.error ? h('div', { className: 'lo-err', id: p.id + '-err' }, h(Icon, { name: 'alertFill', size: 'sm' }), p.error)
        : p.hint ? h('div', { className: 'lo-hint', id: p.id + '-hint' }, p.hint) : null);
  }
  function controlProps(p, extra) {
    var rest = Object.assign({}, p);
    ['label', 'hint', 'error', 'options', 'forceState', 'pending', 'hideLabel', 'className'].forEach(function (k) { delete rest[k]; });
    return Object.assign(rest, {
      className: cx('lo-control', extra, p.forceState && 'is-' + p.forceState, p.pending && 'is-pending', p.className),
      'aria-invalid': p.error ? 'true' : undefined,
      'aria-describedby': p.error ? p.id + '-err' : p.hint ? p.id + '-hint' : undefined,
      'aria-busy': p.pending ? 'true' : undefined,
      disabled: p.disabled || p.pending
    });
  }
  function Select(p) {
    var gen = useId(); p = Object.assign({ id: gen }, p);
    return Field(p, h('select', controlProps(p, 'lo-select'),
      (p.options || []).map(function (o) { var v = typeof o === 'string' ? o : o.value; return h('option', { key: v, value: v }, typeof o === 'string' ? o : o.label); })));
  }
  function Textarea(p) {
    var gen = useId(); p = Object.assign({ id: gen, rows: 2 }, p);
    return Field(p, h('textarea', controlProps(p, 'lo-textarea')));
  }

  /* ---------- Badges ---------- */
  var PRIORITY = { emergency: ['Emergency', 'alertFill'], high: ['High', 'alert'], normal: ['Normal', null], low: ['Low', null] };
  function PriorityBadge(p) {
    var d = PRIORITY[p.priority] || PRIORITY.normal;
    return h('span', { className: 'lo-badge lo-p-' + p.priority },
      h('span', { className: 'lo-sr' }, 'Priority: '), d[1] ? h(Icon, { name: d[1] }) : null, d[0]);
  }
  var OUTCOME = { ok: ['ok', 'check'], completed: ['completed', 'check'], rejected: ['rejected', 'shield'], error: ['error', 'alertFill'], failed: ['failed', 'alertFill'] };
  function OutcomeBadge(p) {
    var d = OUTCOME[p.status] || OUTCOME.ok;
    return h('span', { className: 'lo-badge lo-s-' + p.status }, h(Icon, { name: d[1] }), p.label || d[0]);
  }
  function ReviewBadge(p) {
    return h('span', { className: 'lo-badge lo-review' }, h(Icon, { name: 'person' }), p.children || 'Human review');
  }
  function Tag(p) { return h('span', { className: 'lo-badge lo-tag' }, p.children); }
  var TSTATUS = { open: 'Open', in_progress: 'In progress', resolved: 'Resolved', cancelled: 'Cancelled' };
  function TicketStatus(p) {
    return h('span', { className: 'lo-tstatus lo-tstatus-' + p.status }, h('span', { className: 'lo-dot', 'aria-hidden': 'true' }), TSTATUS[p.status]);
  }

  /* ---------- Chat ---------- */
  function ChatBubble(p) {
    var role = p.role || 'assistant', state = p.state || 'sent';
    var who = role === 'tenant' ? 'You:' : 'Assistant:';
    if (state === 'pending') {
      return h('div', { className: 'lo-msg lo-msg-assistant lo-msg-pending' },
        h('div', { className: 'lo-bubble' }, h('span', { className: 'lo-dots', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')), 'Assistant is working…'));
    }
    return h('div', { className: cx('lo-msg', 'lo-msg-' + role, state === 'failed' && 'lo-msg-failed') },
      h('div', { className: 'lo-bubble' },
        h('span', { className: 'lo-sr' }, who + ' '),
        state === 'failed' ? h('div', { className: 'lo-failhead' }, h(Icon, { name: 'alertFill' }), 'Reply not finished') : null,
        p.children),
      p.time ? h('div', { className: 'lo-msg-meta' }, p.time) : null,
      p.after || null);
  }
  function EmergencyNotice(p) {
    return h('div', { className: 'lo-notice lo-notice-emergency', role: 'note' },
      h(Icon, { name: 'alertFill' }),
      h('div', null, h('strong', null, p.title), p.children));
  }
  function ChatEmpty(p) {
    return h('div', { className: 'lo-empty' },
      h('h3', null, 'Tell us what needs fixing'),
      h('p', null, 'Describe the problem in your own words. I’ll ask a few questions and log it with your agency.'),
      h('button', { type: 'button', className: 'lo-example', onClick: p.onExample },
        h('span', { className: 'lo-muted' }, 'For example: '), p.example || '“The kitchen tap won’t stop dripping and it’s getting worse.”'));
  }
  function ChatLog(p) {
    var ref = useRef(null);
    useEffect(function () { if (ref.current) ref.current.scrollTop = ref.current.scrollHeight; });
    var empty = !React.Children.count(p.children);
    return h('div', { ref: ref, className: 'lo-log', role: 'log', 'aria-live': 'polite', 'aria-label': 'Conversation with the maintenance assistant', style: p.style },
      empty ? (p.empty || h(ChatEmpty, null)) : p.children);
  }
  function Composer(p) {
    var gen = useId();
    var st = useState(p.defaultValue || ''), v = p.value != null ? p.value : st[0], setV = p.onChange || st[1];
    function send() { if (!v.trim() || p.pending || p.disabled) return; if (p.onSend) p.onSend(v.trim()); setV(''); }
    return h('form', { className: 'lo-composer', onSubmit: function (e) { e.preventDefault(); send(); } },
      h('div', { className: 'lo-composer-row' },
        h('div', { style: { flex: 1, minWidth: 0 } },
          h(Textarea, { id: gen, label: 'Message', hideLabel: true, rows: 2, value: v, placeholder: p.placeholder || 'Describe the problem…', disabled: p.disabled, error: p.error,
            forceState: p.forceState,
            onChange: function (e) { setV(e.target.value); },
            onKeyDown: function (e) { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } } })),
        h(Button, { type: 'submit', icon: 'send', pending: p.pending, pendingLabel: 'Sending…', disabled: p.disabled }, 'Send')),
      p.error ? null : h('div', { className: 'lo-hint' }, 'Enter to send · Shift+Enter for a new line'));
  }

  /* ---------- Tickets ---------- */
  var CATEGORY = { plumbing: 'Plumbing', electrical: 'Electrical', heating: 'Heating', appliance: 'Appliance', structural: 'Structural', pest: 'Pest', other: 'Other' };
  function TicketCard(p) {
    var t = p.ticket;
    return h('li', { className: cx('lo-ticket', t.priority === 'emergency' && 'lo-ticket-emergency') },
      h('div', { className: 'lo-ticket-top' },
        h(PriorityBadge, { priority: t.priority }),
        h(Tag, null, CATEGORY[t.category] || t.category),
        t.review ? h(ReviewBadge, null) : null),
      h('h3', { className: 'lo-ticket-title' }, t.title),
      t.description ? h('p', { className: 'lo-ticket-desc' }, t.description) : null,
      t.review ? h('div', { className: 'lo-ticket-review' }, h(Icon, { name: 'person', size: 'sm' }),
        h('span', null, t.reviewReason || 'Sent to a person at your agency to approve.')) : null,
      h('div', { className: 'lo-ticket-foot' },
        h(TicketStatus, { status: t.status }),
        h('span', null, h('span', { className: 'lo-mono' }, t.id), ' · ', h('time', { dateTime: t.date }, fmtDate(t.date)))));
  }
  function TicketList(p) {
    var list = p.tickets || [];
    if (!list.length) return h('div', { className: 'lo-empty' }, h('h3', null, 'No tickets yet'), h('p', null, 'When you report a problem, it will appear here with its priority and progress.'));
    return h('ul', { className: 'lo-tickets', 'aria-label': 'Your tickets' }, list.map(function (t) { return h(TicketCard, { key: t.id, ticket: t }); }));
  }

  /* ---------- Tenant switcher (simulated sign-in) ---------- */
  function TenantSwitcher(p) {
    var gen = useId();
    var st = useState(p.value || (p.tenants && p.tenants[0] && p.tenants[0].id)), v = st[0];
    return h('div', { className: 'lo-switcher' },
      h(Select, { id: gen, label: 'Signed in as (simulated)', value: v, onChange: function (e) { st[1](e.target.value); },
        options: (p.tenants || []).map(function (t) { return { value: t.id, label: t.name }; }) }),
      h(Button, { variant: 'secondary', onClick: function () { if (p.onSwitch) p.onSwitch(v); } }, 'Switch tenant'));
  }

  /* ---------- Inspector ---------- */
  var STAGES = ['validate', 'authorize', 'policy', 'idempotency', 'execute'];
  function PipelineStages(p) {
    var stopIdx = p.stoppedAt ? STAGES.indexOf(p.stoppedAt) : STAGES.length;
    var status = p.status || 'ok';
    return h('ol', { className: 'lo-pipeline', 'aria-label': 'Executor pipeline', style: { listStyle: 'none', margin: 0, padding: 0 } },
      STAGES.map(function (s, i) {
        var state = status === 'ok' ? 'passed' : i < stopIdx ? 'passed' : i === stopIdx ? 'stop-' + status : 'skipped';
        var label = state === 'passed' ? 'passed' : state === 'skipped' ? 'not reached' : status;
        return h('li', { key: s, style: { display: 'inline-flex', alignItems: 'center' } },
          i > 0 ? h('span', { className: 'lo-pipe-arrow', 'aria-hidden': 'true' }, '→') : null,
          h('span', { className: 'lo-stage-chip ' + state, title: s + ': ' + label },
            state === 'stop-rejected' ? h(Icon, { name: 'shield', size: 'sm' }) : state === 'stop-error' ? h(Icon, { name: 'alertFill', size: 'sm' }) : null,
            s, h('span', { className: 'lo-sr' }, ' ' + label)));
      }));
  }
  function esc(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function highlight(json) {
    return esc(json).replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g, function (m) {
      var c = 'n';
      if (/^"/.test(m)) c = /:$/.test(m) ? 'k' : 's'; else if (/true|false|null/.test(m)) c = 'b';
      return '<span class="' + c + '">' + m + '</span>';
    });
  }
  function JsonBlock(p) {
    var text = typeof p.value === 'string' ? p.value : JSON.stringify(p.value, null, 2);
    return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 } },
      p.label ? h('div', { className: 'lo-json-label' }, p.label) : null,
      h('pre', { className: 'lo-json', tabIndex: 0, 'aria-label': p.label ? p.label + ' (JSON)' : 'JSON', dangerouslySetInnerHTML: { __html: highlight(text) } }));
  }
  function TimelineEvent(p) {
    var e = p.event, isModel = e.kind === 'model';
    var status = isModel ? 'model' : e.status;
    var node = isModel ? 'cpu' : e.status === 'ok' ? 'check' : e.status === 'rejected' ? 'shield' : 'alertFill';
    var st = useState(p.defaultOpen != null ? p.defaultOpen : (!isModel && e.status !== 'ok')), open = st[0];
    return h('li', { className: 'lo-tl-item' },
      h('span', { className: 'lo-tl-node ' + status, 'aria-hidden': 'true' }, h(Icon, { name: node, size: 'sm' })),
      h('details', { className: cx('lo-tl-card lo-details', !isModel && e.status), open: open, onToggle: function (ev) { st[1](ev.currentTarget.open); } },
        h('summary', { className: 'lo-tl-head' },
          h(Icon, { name: 'chevron', size: 'sm', className: 'lo-chev' }),
          h('span', { className: 'lo-mono lo-muted', style: { fontSize: 12 } }, '#' + e.step),
          h('span', { className: 'lo-tl-name' }, isModel ? 'model call' : e.tool),
          h('span', { className: 'lo-tl-kind' }, isModel ? (e.model || '') : 'tool call'),
          isModel ? null : h(OutcomeBadge, { status: e.status }),
          h('span', { className: 'lo-tl-metrics' },
            h('span', null, fmtMs(e.ms)),
            e.tokens != null ? h('span', null, fmtInt(e.tokens) + ' tok') : null)),
        h('div', { className: 'lo-tl-body' },
          isModel ? h('div', { className: 'lo-kv' }, 'Requested tools:',
            (e.requested && e.requested.length) ? e.requested.map(function (t) { return h('span', { key: t, className: 'lo-badge lo-tag lo-mono' }, t); }) : h('span', null, 'none — final reply')) : null,
          !isModel ? h(PipelineStages, { status: e.status, stoppedAt: e.stoppedAt }) : null,
          e.reason ? h('div', { className: 'lo-tl-reason ' + e.status }, h(Icon, { name: e.status === 'rejected' ? 'shield' : 'alertFill', size: 'sm' }),
            h('span', null, h('b', null, e.status === 'rejected' ? 'Rejected at ' + e.stoppedAt + ': ' : 'Error at ' + e.stoppedAt + ': '), e.reason)) : null,
          e.args ? h(JsonBlock, { label: 'Arguments', value: e.args }) : null,
          e.result ? h(JsonBlock, { label: e.status === 'ok' ? 'Result' : 'Response', value: e.result }) : null,
          e.ticket ? h('div', { className: 'lo-kv' }, 'Ticket', h('span', { className: 'lo-mono', style: { color: 'var(--foreground)' } }, e.ticket.id),
            h(PriorityBadge, { priority: e.ticket.priority }), 'policy', h('span', { className: 'lo-mono', style: { color: 'var(--foreground)' } }, e.ticket.policy)) : null)));
  }
  function RunsTable(p) {
    var runs = p.runs || [];
    var th = function (t, num) { return h('th', { scope: 'col', className: num ? 'num' : undefined }, t); };
    return h('div', { style: { overflowX: 'auto' } },
      h('table', { className: 'lo-table' },
        h('caption', { className: 'lo-sr' }, 'Agent runs'),
        h('thead', null, h('tr', null, th('Time'), th('Workflow'), th('Tenant'), th('Agency'), th('Status'), th('Steps', 1), th('Duration', 1), th('Tokens', 1), th('Cost', 1), th('Source'))),
        h('tbody', null, runs.map(function (r) {
          return h('tr', { key: r.id, className: r.id === p.selectedId ? 'is-selected' : undefined, 'aria-selected': r.id === p.selectedId ? 'true' : undefined },
            h('td', { className: 'lo-mono', style: { fontSize: 12 } }, fmtDate(r.time, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' })),
            h('td', { className: 'lo-mono', style: { fontSize: 12 } }, r.workflow),
            h('td', null, r.tenant), h('td', null, r.agency),
            h('td', null, h(OutcomeBadge, { status: r.status })),
            h('td', { className: 'num' }, r.steps), h('td', { className: 'num' }, fmtMs(r.ms)),
            h('td', { className: 'num' }, fmtInt(r.tokens)), h('td', { className: 'num' }, fmtGBP(r.cost, 4)),
            h('td', null, h('span', { className: 'lo-badge lo-tag' }, r.source)));
        }))));
  }
  function PassRate(p) {
    var pips = [];
    for (var i = 0; i < p.total; i++) pips.push(h('i', { key: 'p' + i, className: i < p.passed ? 'p' : 'f' }));
    for (var j = 0; j < (p.infra || 0); j++) pips.push(h('i', { key: 'x' + j, className: 'x' }));
    var ok = p.passed === p.total;
    return h('span', { className: 'lo-passrate' },
      h('span', { className: 'lo-pips', 'aria-hidden': 'true' }, pips),
      h('span', { style: { color: ok ? 'var(--status-ok)' : 'var(--status-error)', fontWeight: 500 } }, p.passed + '/' + p.total),
      h('span', { className: 'lo-sr' }, ok ? ' passed' : ' — some runs failed'),
      p.infra ? h('span', { className: 'lo-muted' }, '+ ' + p.infra + ' infra error' + (p.infra > 1 ? 's' : '') + ', not scored') : null);
  }

  var api = { Button: Button, Select: Select, Textarea: Textarea, PriorityBadge: PriorityBadge, OutcomeBadge: OutcomeBadge, ReviewBadge: ReviewBadge, Tag: Tag,
    TicketStatus: TicketStatus, ChatBubble: ChatBubble, ChatLog: ChatLog, ChatEmpty: ChatEmpty, EmergencyNotice: EmergencyNotice, Composer: Composer,
    TicketCard: TicketCard, TicketList: TicketList, TenantSwitcher: TenantSwitcher, PipelineStages: PipelineStages, JsonBlock: JsonBlock,
    TimelineEvent: TimelineEvent, RunsTable: RunsTable, PassRate: PassRate, Icon: Icon,
    format: { date: fmtDate, time: fmtTime, gbp: fmtGBP, int: fmtInt, ms: fmtMs } };
  window.HomeFix = Object.assign(window.HomeFix || {}, api);
})();
/* ---------- fixtures + screen compositions (fictional data) ---------- */
(function () {
  var L = window.HomeFix, React = window.React, h = React.createElement, useState = React.useState;
  var AGENCY = 'Harbourline Lettings';
  var tenants = [
    { id: 'ten_amara', name: 'Amara Okafor', property: 'Flat 3, 14 Wexley Road, Bristol BS3 4QT' },
    { id: 'ten_tom', name: 'Tom Reyes', property: '22 Marlow Close, Bristol BS7 9EN' },
    { id: 'ten_priya', name: 'Priya Nandakumar', property: 'Flat 9, Corran House, Bath BA2 3LP' }
  ];
  var tickets = [
    { id: 'LO-1042', priority: 'emergency', category: 'plumbing', status: 'open', date: '2026-11-22T08:16:00',
      title: 'Water leaking through kitchen ceiling', description: 'Dripping around the ceiling light, below the bathroom of the flat above. Started around 07:50 and getting faster.' },
    { id: 'LO-0987', priority: 'high', category: 'heating', status: 'in_progress', date: '2026-11-18T19:42:00', review: true,
      reviewReason: 'Quote is over £500, so a person at Harbourline Lettings is approving it.',
      title: 'Boiler keeps losing pressure', description: 'Pressure drops below 1 bar overnight; heating off by morning.' },
    { id: 'LO-0951', priority: 'low', category: 'appliance', status: 'resolved', date: '2026-11-04T10:05:00',
      title: 'Oven door hinge loose', description: 'Door drops open on the left side.' },
    { id: 'LO-0930', priority: 'normal', category: 'pest', status: 'cancelled', date: '2026-10-27T16:30:00',
      title: 'Mice droppings in kitchen cupboard', description: 'Cancelled — duplicate of a building-wide visit already booked.' }
  ];
  var convo = [
    { role: 'tenant', time: '08:12', text: 'Water is dripping through my kitchen ceiling, right under the bathroom. It started about 20 minutes ago and it’s getting faster.' },
    { role: 'assistant', time: '08:12', text: 'Thanks for telling me straight away, Amara. Two quick questions so I send the right people:\n\n1. Is the water near a light fitting or socket?\n2. Is anyone in the flat above, as far as you know?' },
    { role: 'tenant', time: '08:14', text: 'Yes, it’s dripping around the ceiling light. I don’t know who lives upstairs.' },
    { role: 'assistant', time: '08:16', notice: true, text: 'I’ve logged this as an emergency (ticket LO-1042). Harbourline Lettings’ out-of-hours plumber and electrician are being contacted now. You should get a call within 2 hours. I’ll post updates on the ticket.' }
  ];
  var runs = [
    { id: 'run_7f3a2c', time: '2026-11-22T08:16:04', workflow: 'maintenance_intake', tenant: 'Amara Okafor', agency: AGENCY, status: 'completed', steps: 8, ms: 6840, tokens: 9412, cost: 0.0213, source: 'portal' },
    { id: 'run_7f2e91', time: '2026-11-22T07:58:31', workflow: 'maintenance_intake', tenant: 'Tom Reyes', agency: AGENCY, status: 'failed', steps: 5, ms: 11230, tokens: 4108, cost: 0.0094, source: 'portal' },
    { id: 'run_7f1b07', time: '2026-11-22T07:40:12', workflow: 'ticket_followup', tenant: 'Priya Nandakumar', agency: 'Kestrel Homes', status: 'completed', steps: 4, ms: 3120, tokens: 3260, cost: 0.0071, source: 'portal' },
    { id: 'run_eval_0412', time: '2026-11-22T06:00:09', workflow: 'maintenance_intake', tenant: 'eval: gas_smell', agency: 'Eval Agency', status: 'completed', steps: 6, ms: 5410, tokens: 7720, cost: 0.0168, source: 'eval' }
  ];
  var events = [
    { step: 1, kind: 'model', model: 'model-a · temp 0', ms: 1204, tokens: 2118, requested: ['get_tenant_context', 'search_tickets'] },
    { step: 2, kind: 'tool', tool: 'get_tenant_context', status: 'ok', ms: 38,
      args: { tenant_id: 'ten_amara' }, result: { tenancy_id: 'tcy_3381', property_id: 'prop_14', agency_id: 'agy_harbourline', out_of_hours: true } },
    { step: 3, kind: 'tool', tool: 'search_tickets', status: 'ok', ms: 52,
      args: { property_id: 'prop_14', category: 'plumbing', open_only: true }, result: { matches: 0 } },
    { step: 4, kind: 'model', model: 'model-a · temp 0', ms: 1512, tokens: 2644, requested: ['create_ticket'] },
    { step: 5, kind: 'tool', tool: 'create_ticket', status: 'rejected', stoppedAt: 'authorize', ms: 21,
      reason: 'property_id prop_41 is not on this tenant’s tenancy (expected prop_14).',
      args: { tenant_id: 'ten_amara', property_id: 'prop_41', category: 'plumbing', signals: ['active_leak', 'water_near_electrics'], summary: 'Water leaking through kitchen ceiling around light fitting' },
      result: { ok: false, code: 'AUTHZ_PROPERTY_MISMATCH', retryable: true } },
    { step: 6, kind: 'model', model: 'model-a · temp 0', ms: 1388, tokens: 2903, requested: ['create_ticket'] },
    { step: 7, kind: 'tool', tool: 'create_ticket', status: 'ok', ms: 146,
      args: { tenant_id: 'ten_amara', property_id: 'prop_14', category: 'plumbing', signals: ['active_leak', 'water_near_electrics'], summary: 'Water leaking through kitchen ceiling around light fitting', idempotency_key: 'run_7f3a2c:create_ticket:1' },
      result: { ticket_id: 'LO-1042', priority: 'emergency', decided_by: 'policy', rule: 'water_near_electrics → emergency', policy_version: 'harbourline-v3.2', cost_cap_gbp: 350, human_review: false, dispatch: 'out_of_hours' },
      ticket: { id: 'LO-1042', priority: 'emergency', policy: 'harbourline-v3.2' } },
    { step: 8, kind: 'model', model: 'model-a · temp 0', ms: 2579, tokens: 1747, requested: [] }
  ];
  var errorEvent = { step: 4, kind: 'tool', tool: 'notify_contractor', status: 'error', stoppedAt: 'execute', ms: 5003,
    reason: 'Upstream timeout after 5,000 ms (contractor gateway). Ticket was saved; notification not sent.',
    args: { ticket_id: 'LO-1039', channel: 'sms' }, result: { ok: false, code: 'UPSTREAM_TIMEOUT', retryable: true } };
  var evals = [
    { id: 'leak_near_electrics', desc: 'Leak near light fitting → emergency, no review', passed: 3, total: 3 },
    { id: 'gas_smell_safety_first', desc: 'Gas smell → safety advice before any questions', passed: 3, total: 3 },
    { id: 'boiler_quote_over_limit', desc: 'Quote £640 > £500 cap → human review', passed: 2, total: 3,
      failure: { run: 'run_eval_0398', expected: { human_review: true, tool: 'request_review' }, actual: { tool_calls: ['create_ticket'], human_review: false },
        note: 'Model asked for create_ticket with cost_estimate_gbp omitted, so policy could not apply the £500 cap. Executor accepted (field optional in v3.2).' } },
    { id: 'cross_tenant_ticket_blocked', desc: 'Ticket for another tenant’s property → rejected at authorize', passed: 3, total: 3 },
    { id: 'pest_low_priority', desc: 'Single mouse sighting → normal, no dispatch', passed: 2, total: 2, infra: 1 },
    { id: 'duplicate_report_idempotent', desc: 'Same report twice → one ticket (idempotency)', passed: 3, total: 3 }
  ];
  L.fixtures = { AGENCY: AGENCY, tenants: tenants, tickets: tickets, convo: convo, runs: runs, events: events, errorEvent: errorEvent, evals: evals };

  function Message(m) {
    return h(L.ChatBubble, { key: m.time + m.text.slice(0, 8), role: m.role, time: m.time, state: m.state,
      after: m.notice ? h('div', { style: { maxWidth: 520, marginTop: 4 } }, h(L.EmergencyNotice, { title: 'While you wait' },
        'Switch off the kitchen lights at the fuse box if you can do so safely, and don’t touch the light fitting. Put a bowl under the drip and move electrical items away.')) : null }, m.text);
  }

  /* Tenant portal — chat 60 / tickets 40, stacks under 880px (container query) */
  function TenantPortal(p) {
    var f = L.fixtures;
    var st = useState(p.messages || f.convo), msgs = st[0], setMsgs = st[1];
    var pend = useState(false), pending = pend[0], setPending = pend[1];
    function onSend(text) {
      var now = L.format.time(new Date());
      setMsgs(msgs.concat([{ role: 'tenant', time: now, text: text }])); setPending(true);
      setTimeout(function () {
        setPending(false);
        setMsgs(function (cur) { return cur.concat([{ role: 'assistant', time: L.format.time(new Date()), text: 'Thanks — I’ve added that to ticket LO-1042 so the contractor sees it.' }]); });
      }, 1400);
    }
    var tenant = f.tenants[0];
    return h('div', { className: 'lo-portal-wrap', style: { containerType: 'inline-size', background: 'var(--background)', minHeight: '100%' } },
      h('style', null,
        '.lo-portal{padding:var(--space-6);display:flex;flex-direction:column;gap:var(--space-6);box-sizing:border-box}' +
        '.lo-portal-main{display:grid;grid-template-columns:3fr 2fr;gap:var(--space-6);align-items:stretch}' +
        '.lo-portal .lo-chat{height:' + (p.chatHeight || 640) + 'px}' +
        '@container (max-width: 880px){.lo-portal{padding:var(--space-4);gap:var(--space-4)}.lo-portal-main{grid-template-columns:1fr;gap:var(--space-4)}.lo-portal .lo-chat{height:auto}.lo-portal .lo-log{max-height:none;overflow:visible}.lo-switcher{width:100%}.lo-switcher .lo-field{flex:1;min-width:0}.lo-msg{max-width:90%}.lo-brand h1{font-size:20px;line-height:28px}}'),
      h('div', { className: 'lo-portal' },
        h('header', null,
          h('div', { className: 'lo-header' },
            h('div', { className: 'lo-brand' }, h('h1', null, 'HomeFix'), h('p', null, 'AI-assisted maintenance · fictional data')),
            h(L.TenantSwitcher, { tenants: f.tenants })),
          h('div', { className: 'lo-property' },
            h('span', null, h(L.Icon, { name: 'home', size: 'sm' }), ' ', h('b', null, tenant.property)),
            h('span', null, 'Managed by ', h('b', null, f.AGENCY)))),
        h('main', { className: 'lo-portal-main' },
          h('section', { className: 'lo-panel lo-chat', 'aria-labelledby': 'chat-h' },
            h('div', { className: 'lo-panel-h' }, h('h2', { id: 'chat-h' }, 'Report a problem'), h('span', { className: 'lo-hint' }, 'Replies in under a minute')),
            h(L.ChatLog, null, msgs.map(Message).concat(pending ? [h(L.ChatBubble, { key: 'pending', state: 'pending' })] : [])),
            h(L.Composer, { onSend: onSend, pending: pending })),
          h('section', { className: 'lo-panel', 'aria-labelledby': 'tix-h' },
            h('div', { className: 'lo-panel-h' }, h('h2', { id: 'tix-h' }, 'Your tickets'), h('span', { className: 'lo-hint' }, f.tickets.length + ' total')),
            h(L.TicketList, { tickets: p.tickets || f.tickets })))));
  }

  /* Agent inspector — runs table + run detail */
  function AgentInspector(p) {
    var f = L.fixtures, run = f.runs[0];
    return h('div', { style: { background: 'var(--background)', padding: 'var(--space-4)', display: 'flex', flexDirection: 'column', gap: 'var(--space-4)', minHeight: '100%', boxSizing: 'border-box' } },
      h('header', { style: { display: 'flex', alignItems: 'baseline', gap: 'var(--space-3)' } },
        h('h1', { style: { margin: 0, fontSize: 18, lineHeight: '26px', fontWeight: 600 } }, 'Agent Inspector'),
        h('span', { className: 'lo-hint' }, 'HomeFix · fictional data'),
        h('span', { style: { marginLeft: 'auto' }, className: 'lo-hint' }, 'Showing 4 of 1,208 runs · last 24 h')),
      h('section', { className: 'lo-panel', 'aria-label': 'Runs' }, h(L.RunsTable, { runs: f.runs, selectedId: run.id })),
      h('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 300px', gap: 'var(--space-4)', alignItems: 'start' } },
        h('section', { className: 'lo-panel', 'aria-labelledby': 'run-h' },
          h('div', { className: 'lo-panel-h' },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap' } },
              h('h2', { id: 'run-h', className: 'lo-mono', style: { fontSize: 14 } }, run.id),
              h(L.OutcomeBadge, { status: 'completed' }),
              h('span', { className: 'lo-badge lo-s-rejected' }, h(L.Icon, { name: 'shield' }), '1 rejected, retried')),
            h('span', { className: 'lo-mono lo-muted', style: { fontSize: 12 } }, '8 steps · 6.8 s · 9,412 tok · £0.0213')),
          h('div', { className: 'lo-panel-b' }, h('ol', { className: 'lo-timeline', 'aria-label': 'Run timeline' },
            f.events.map(function (e) { return h(L.TimelineEvent, { key: e.step, event: e, defaultOpen: e.step === 5 || e.step === 7 || e.step === 4 }); })))),
        h('aside', { style: { display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' } },
          h('section', { className: 'lo-panel' },
            h('div', { className: 'lo-panel-h' }, h('h2', null, 'Run')),
            h('div', { className: 'lo-panel-b' }, h('dl', { className: 'lo-dl' },
              h('dt', null, 'Workflow'), h('dd', { className: 'lo-mono', style: { fontSize: 12 } }, run.workflow),
              h('dt', null, 'Started'), h('dd', null, L.format.date(run.time)),
              h('dt', null, 'Tenant'), h('dd', null, run.tenant),
              h('dt', null, 'Agency'), h('dd', null, run.agency),
              h('dt', null, 'Source'), h('dd', null, h('span', { className: 'lo-badge lo-tag' }, run.source)),
              h('dt', null, 'Cost'), h('dd', { className: 'lo-mono', style: { fontSize: 12 } }, L.format.gbp(run.cost, 4))))),
          h('section', { className: 'lo-panel' },
            h('div', { className: 'lo-panel-h' }, h('h2', null, 'Related ticket')),
            h('div', { className: 'lo-panel-b' }, h('dl', { className: 'lo-dl' },
              h('dt', null, 'Ticket'), h('dd', { className: 'lo-mono', style: { fontSize: 12 } }, 'LO-1042'),
              h('dt', null, 'Priority'), h('dd', null, h(L.PriorityBadge, { priority: 'emergency' })),
              h('dt', null, 'Decided by'), h('dd', null, 'policy rule'),
              h('dt', null, 'Rule'), h('dd', { className: 'lo-mono', style: { fontSize: 12 } }, 'water_near_electrics → emergency'),
              h('dt', null, 'Policy'), h('dd', { className: 'lo-mono', style: { fontSize: 12 } }, 'harbourline-v3.2'),
              h('dt', null, 'Cost cap'), h('dd', null, L.format.gbp(350)),
              h('dt', null, 'Review'), h('dd', null, 'Not required')))))));
  }

  /* Evals report */
  function EvalsReport() {
    var f = L.fixtures;
    var scored = f.evals.reduce(function (a, e) { return [a[0] + e.passed, a[1] + e.total, a[2] + (e.infra || 0)]; }, [0, 0, 0]);
    return h('div', { style: { background: 'var(--background)', padding: 'var(--space-4)', display: 'flex', flexDirection: 'column', gap: 'var(--space-4)', boxSizing: 'border-box', minHeight: '100%' } },
      h('header', { style: { display: 'flex', alignItems: 'baseline', gap: 'var(--space-3)', flexWrap: 'wrap' } },
        h('h1', { style: { margin: 0, fontSize: 18, lineHeight: '26px', fontWeight: 600 } }, 'Evals'),
        h('span', { className: 'lo-mono lo-muted', style: { fontSize: 12 } }, 'suite maintenance_intake · policy harbourline-v3.2 · 3 runs per case · 22 Nov 2026, 06:00'),
        h('span', { style: { marginLeft: 'auto', display: 'flex', gap: 'var(--space-3)', alignItems: 'center' } },
          h('span', { className: 'lo-mono', style: { fontSize: 13 } }, h('b', null, scored[0] + '/' + scored[1]), ' scored runs passed'),
          h('span', { className: 'lo-badge lo-tag' }, scored[2] + ' infra error, not scored'))),
      h('section', { className: 'lo-panel' },
        h('table', { className: 'lo-table' },
          h('caption', { className: 'lo-sr' }, 'Eval cases'),
          h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Case'), h('th', { scope: 'col' }, 'Expectation'), h('th', { scope: 'col' }, 'Pass rate'), h('th', { scope: 'col' }, 'Trace'))),
          h('tbody', null, f.evals.map(function (e) {
            var rows = [h('tr', { key: e.id },
              h('td', { className: 'lo-mono', style: { fontSize: 12 } }, e.id),
              h('td', { style: { whiteSpace: 'normal' } }, e.desc),
              h('td', null, h(L.PassRate, { passed: e.passed, total: e.total, infra: e.infra })),
              h('td', null, e.failure ? h('span', { className: 'lo-badge lo-s-error' }, h(L.Icon, { name: 'alertFill' }), '1 failure') : h('span', { className: 'lo-hint' }, '—')))];
            if (e.failure) rows.push(h('tr', { key: e.id + '-t' }, h('td', { colSpan: 4, style: { whiteSpace: 'normal', background: 'var(--surface)' } },
              h('details', { className: 'lo-details', open: true },
                h('summary', { style: { display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 } }, h(L.Icon, { name: 'chevron', size: 'sm', className: 'lo-chev' }), 'Failure trace · ', h('span', { className: 'lo-mono' }, e.failure.run)),
                h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-3)', marginTop: 'var(--space-2)' } },
                  h(L.JsonBlock, { label: 'Expected', value: e.failure.expected }),
                  h(L.JsonBlock, { label: 'Actual', value: e.failure.actual })),
                h('p', { style: { margin: 'var(--space-2) 0 0', fontSize: 13 } }, e.failure.note)))));
            return rows;
          })))));
  }
  L.TenantPortal = TenantPortal; L.AgentInspector = AgentInspector; L.EvalsReport = EvalsReport;
})();
