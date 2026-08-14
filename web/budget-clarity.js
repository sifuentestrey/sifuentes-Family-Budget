(() => {
  const app = document.getElementById('app');
  if (!app) return;

  let billsCenterPromise = null;
  const loadBillsCenter = () => {
    if (!billsCenterPromise) billsCenterPromise = import('./bills-center.js');
    return billsCenterPromise;
  };

  const ensureStyle = () => {
    if (document.getElementById('budget-clarity-style')) return;
    const style = document.createElement('style');
    style.id = 'budget-clarity-style';
    style.textContent = `
      .seg:has(.seg-btn[data-view="budget"]) {
        margin-bottom: 18px;
      }

      .seg:has(.seg-btn[data-view="budget"]) .seg-btn {
        min-height: 38px;
        font-size: 13px;
      }

      #app:has(.seg-btn[data-view="budget"].active) main > .hero {
        margin-bottom: 4px;
      }

      #app:has(.seg-btn[data-view="bills"].active) main > .hero {
        margin-bottom: 8px;
      }

      #app:has(.seg-btn[data-view="bills"].active) .section-title,
      #app:has(.seg-btn[data-view="budget"].active) .section-title {
        letter-spacing: -0.035em;
      }

      /* Bills rows: the status badge gets its own non-shrinking slot. Long
         provider names ellipsize before they can shove PAID/DUE off-screen. */
      #app:has(.seg-btn[data-view="bills"].active) [data-bill-center] .bill-center-row.paid {
        opacity: 1 !important;
      }

      #app:has(.seg-btn[data-view="bills"].active) [data-bill-center] .bill-center-row .row-body {
        min-width: 0;
      }

      #app:has(.seg-btn[data-view="bills"].active) [data-bill-center] .bill-center-row .row-title {
        display: flex;
        align-items: center;
        gap: 7px;
        min-width: 0;
        width: 100%;
      }

      #app:has(.seg-btn[data-view="bills"].active) [data-bill-center] .bill-row-name {
        flex: 1 1 auto;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      #app:has(.seg-btn[data-view="bills"].active) [data-bill-center] .bill-primary-status {
        flex: 0 0 auto;
        margin-left: 0 !important;
        text-transform: uppercase;
        letter-spacing: .055em;
        font-size: 10px;
        font-weight: 850;
        line-height: 1;
        padding: 6px 9px;
      }

      #app:has(.seg-btn[data-view="bills"].active) [data-bill-center] .bill-center-row .row-title .chip:not(.bill-primary-status) {
        display: none;
      }

      #app:has(.seg-btn[data-view="bills"].active) [data-bill-center] .bill-center-row .row-sub {
        margin-top: 3px;
        line-height: 1.42;
      }

      /* Useful calendar instead of dots: each day shows paid/due money, and a
         selected day opens a compact agenda directly under the grid. */
      #app:has(.seg-btn[data-view="bills"].active) [data-bill-center] .bill-calendar {
        padding: 11px;
      }

      #app:has(.seg-btn[data-view="bills"].active) [data-bill-center] .bill-day {
        min-height: 60px !important;
        padding: 5px 3px !important;
        align-items: stretch !important;
        justify-content: flex-start;
        gap: 3px !important;
        cursor: pointer;
        outline-offset: -1px;
      }

      #app:has(.seg-btn[data-view="bills"].active) [data-bill-center] .bill-day-num {
        text-align: center;
        line-height: 1.1;
      }

      #app:has(.seg-btn[data-view="bills"].active) [data-bill-center] .bill-day.selected {
        background: var(--accent-soft) !important;
        outline: 2px solid var(--accent);
      }

      #app:has(.seg-btn[data-view="bills"].active) [data-bill-center] .bill-day-dots,
      #app:has(.seg-btn[data-view="bills"].active) [data-bill-center] .bill-day-count {
        display: none !important;
      }

      #app:has(.seg-btn[data-view="bills"].active) [data-bill-center] .bill-calendar-mini {
        display: block;
        width: 100%;
        min-width: 0;
        border-radius: 5px;
        padding: 2px 1px;
        text-align: center;
        font-size: 8.5px;
        font-weight: 800;
        line-height: 1.05;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        font-variant-numeric: tabular-nums;
      }

      #app:has(.seg-btn[data-view="bills"].active) [data-bill-center] .bill-calendar-mini.paid {
        color: var(--positive);
        background: var(--positive-soft);
      }

      #app:has(.seg-btn[data-view="bills"].active) [data-bill-center] .bill-calendar-mini.due {
        color: var(--accent-ink);
        background: var(--accent-soft);
      }

      #app:has(.seg-btn[data-view="bills"].active) [data-bill-center] .bill-calendar-agenda {
        border-top: 1px solid var(--border);
        margin-top: 10px;
        padding-top: 10px;
      }

      #app:has(.seg-btn[data-view="bills"].active) [data-bill-center] .bill-calendar-agenda-head {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 10px;
        margin: 0 2px 7px;
      }

      #app:has(.seg-btn[data-view="bills"].active) [data-bill-center] .bill-calendar-agenda-title {
        font-size: 13px;
        font-weight: 800;
        color: var(--text);
      }

      #app:has(.seg-btn[data-view="bills"].active) [data-bill-center] .bill-calendar-agenda-total {
        font-size: 11px;
        color: var(--muted);
        font-variant-numeric: tabular-nums;
      }

      #app:has(.seg-btn[data-view="bills"].active) [data-bill-center] .bill-agenda-item {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 3px 10px;
        padding: 8px 7px;
        border-radius: 10px;
      }

      #app:has(.seg-btn[data-view="bills"].active) [data-bill-center] .bill-agenda-item + .bill-agenda-item {
        border-top: 1px solid var(--border);
        border-radius: 0;
      }

      #app:has(.seg-btn[data-view="bills"].active) [data-bill-center] .bill-agenda-name {
        min-width: 0;
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 12px;
        font-weight: 780;
      }

      #app:has(.seg-btn[data-view="bills"].active) [data-bill-center] .bill-agenda-name > span:first-child {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      #app:has(.seg-btn[data-view="bills"].active) [data-bill-center] .bill-agenda-status {
        flex: 0 0 auto;
        border-radius: 999px;
        padding: 3px 6px;
        font-size: 8px;
        font-weight: 850;
        letter-spacing: .05em;
        text-transform: uppercase;
      }

      #app:has(.seg-btn[data-view="bills"].active) [data-bill-center] .bill-agenda-status.paid {
        color: var(--positive);
        background: var(--positive-soft);
      }

      #app:has(.seg-btn[data-view="bills"].active) [data-bill-center] .bill-agenda-status.due {
        color: var(--accent-ink);
        background: var(--accent-soft);
      }

      #app:has(.seg-btn[data-view="bills"].active) [data-bill-center] .bill-agenda-amount {
        font-size: 12px;
        font-weight: 800;
        font-variant-numeric: tabular-nums;
      }

      #app:has(.seg-btn[data-view="bills"].active) [data-bill-center] .bill-agenda-meta {
        grid-column: 1 / -1;
        color: var(--muted);
        font-size: 10.5px;
        line-height: 1.35;
      }

      #app:has(.seg-btn[data-view="bills"].active) [data-bill-center] .bill-agenda-empty {
        color: var(--muted);
        font-size: 11px;
        padding: 8px 4px 3px;
      }

      @media (max-width: 390px) {
        #app:has(.seg-btn[data-view="bills"].active) [data-bill-center] .bill-day {
          min-height: 56px !important;
        }

        #app:has(.seg-btn[data-view="bills"].active) [data-bill-center] .bill-calendar-mini {
          font-size: 7.5px;
        }
      }
    `;
    document.head.appendChild(style);
  };

  const setOwnText = (node, value) => {
    if (!node) return;
    const textNode = [...node.childNodes].find(
      (child) => child.nodeType === Node.TEXT_NODE && child.textContent.trim(),
    );
    if (textNode) {
      if (textNode.textContent.trim() !== value) textNode.textContent = `
          ${value}
          `;
      return;
    }
    node.appendChild(document.createTextNode(value));
  };

  const setText = (node, value) => {
    if (node && node.textContent.trim() !== value) node.textContent = value;
  };

  const sectionByTitle = (title) => [...document.querySelectorAll('main .section')]
    .find((section) => section.querySelector('.section-title')?.textContent.trim() === title);

  const renameSection = (from, to, sub = null) => {
    const section = sectionByTitle(from);
    if (!section) return null;
    setText(section.querySelector('.section-title'), to);
    if (sub !== null) setText(section.querySelector('.section-sub'), sub);
    return section;
  };

  const compactMoney = (value) => {
    const number = Number(String(value ?? '').replace(/[^0-9.-]/g, ''));
    if (!Number.isFinite(number)) return String(value ?? '');
    const abs = Math.abs(number);
    if (abs >= 1000) {
      const scaled = abs / 1000;
      const digits = scaled >= 10 ? 0 : 1;
      return `$${scaled.toFixed(digits).replace(/\.0$/, '')}k`;
    }
    return `$${Math.round(abs)}`;
  };

  const htmlEsc = (value) => String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');

  const rowName = (title) => {
    const existing = title.querySelector('.bill-row-name');
    if (existing) return existing.textContent.trim();
    const textNode = [...title.childNodes].find(
      (child) => child.nodeType === Node.TEXT_NODE && child.textContent.trim(),
    );
    return textNode?.textContent.trim() ?? '';
  };

  const enrichBillRow = (row) => {
    const title = row.querySelector('.row-title');
    const sub = row.querySelector('.row-sub');
    if (!title || !sub) return;

    if (!title.querySelector('.bill-row-name')) {
      const textNode = [...title.childNodes].find(
        (child) => child.nodeType === Node.TEXT_NODE && child.textContent.trim(),
      );
      if (textNode) {
        const name = document.createElement('span');
        name.className = 'bill-row-name';
        name.textContent = textNode.textContent.trim();
        title.replaceChild(name, textNode);
      }
    }

    const chips = [...title.querySelectorAll('.chip')];
    const primary = chips.find((chip) => /^(paid|due)$/i.test(chip.textContent.trim()));
    if (primary) primary.classList.add('bill-primary-status');

    if (sub.dataset.scheduleEnriched === '1') return;

    const original = sub.textContent
      .split('·')
      .map((part) => part.trim())
      .filter(Boolean);

    const date = original[0] ?? '';
    const assignment = original.find((part) =>
      /paycheck|needs money already|assignment later/i.test(part),
    ) ?? null;
    const category = original.find((part, index) =>
      index > 0 && part !== assignment,
    ) ?? null;

    const chipText = chips.map((chip) => chip.textContent.trim().toLowerCase());
    const payment = chipText.includes('auto')
      ? 'Auto'
      : chipText.includes('you pay')
        ? 'You pay'
        : null;
    const amountMode = chipText.includes('varies') ? 'Varies' : null;

    sub.textContent = [date, payment, assignment, category, amountMode]
      .filter(Boolean)
      .join(' · ');
    sub.dataset.scheduleEnriched = '1';
  };

  const billRowsForCalendar = (center) => [...center.querySelectorAll('.bill-center-row')]
    .map((row) => {
      enrichBillRow(row);
      const title = row.querySelector('.row-title');
      const sub = row.querySelector('.row-sub');
      const amountNode = row.querySelector('.row-amount');
      if (!title || !sub || !amountNode) return null;

      const dateMatch = sub.textContent.match(/\b(?:Paid|Due)\s+[A-Z][a-z]{2}\s+(\d{1,2})\b/);
      if (!dateMatch) return null;

      const name = rowName(title);
      const amountText = amountNode.textContent.trim();
      const amount = Number(amountText.replace(/[^0-9.-]/g, '')) || 0;
      return {
        day: Number(dateMatch[1]),
        name,
        amount,
        amountText,
        status: row.classList.contains('paid') ? 'paid' : 'due',
        schedule: sub.textContent.trim(),
      };
    })
    .filter(Boolean);

  const selectedCalendarDay = (center, rows) => {
    const existing = Number(center.dataset.selectedBillDay || 0);
    if (existing && rows.some((row) => row.day === existing)) return existing;

    const monthText = center.querySelector('.bill-month-nav strong')?.textContent.trim() ?? '';
    const monthDate = new Date(`${monthText} 1`);
    const now = new Date();
    const sameMonth = !Number.isNaN(monthDate.getTime())
      && monthDate.getFullYear() === now.getFullYear()
      && monthDate.getMonth() === now.getMonth();

    if (sameMonth) {
      const today = now.getDate();
      if (rows.some((row) => row.day === today)) return today;
      const nextDue = rows
        .filter((row) => row.status === 'due' && row.day >= today)
        .sort((a, b) => a.day - b.day)[0];
      if (nextDue) return nextDue.day;
      const later = rows.filter((row) => row.day >= today).sort((a, b) => a.day - b.day)[0];
      if (later) return later.day;
    }

    return rows.sort((a, b) => a.day - b.day)[0]?.day ?? null;
  };

  const renderCalendarAgenda = (center, day, rows) => {
    const calendar = center.querySelector('.bill-calendar');
    if (!calendar) return;

    let agenda = calendar.querySelector('.bill-calendar-agenda');
    if (!agenda) {
      agenda = document.createElement('div');
      agenda.className = 'bill-calendar-agenda';
      calendar.appendChild(agenda);
    }

    const monthText = center.querySelector('.bill-month-nav strong')?.textContent.trim() ?? '';
    const date = new Date(`${monthText} ${day}`);
    const dateLabel = Number.isNaN(date.getTime())
      ? `Day ${day}`
      : date.toLocaleDateString('en-US', {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
      });

    const dayRows = rows.filter((row) => row.day === day);
    const total = dayRows.reduce((sum, row) => sum + row.amount, 0);

    agenda.innerHTML = `
      <div class="bill-calendar-agenda-head">
        <div class="bill-calendar-agenda-title">${htmlEsc(dateLabel)}</div>
        <div class="bill-calendar-agenda-total">${dayRows.length ? `${dayRows.length} item${dayRows.length === 1 ? '' : 's'} · ${compactMoney(total)}` : ''}</div>
      </div>
      ${dayRows.length
        ? dayRows.map((row) => `
          <div class="bill-agenda-item">
            <div class="bill-agenda-name">
              <span>${htmlEsc(row.name)}</span>
              <span class="bill-agenda-status ${row.status}">${row.status}</span>
            </div>
            <div class="bill-agenda-amount">${htmlEsc(row.amountText)}</div>
            <div class="bill-agenda-meta">${htmlEsc(row.schedule)}</div>
          </div>
        `).join('')
        : '<div class="bill-agenda-empty">Nothing scheduled for this day.</div>'}
    `;
  };

  const polishBillsCalendar = (center) => {
    const calendar = center.querySelector('.bill-calendar');
    if (!calendar) return;

    const rows = billRowsForCalendar(center);
    const byDay = new Map();
    for (const row of rows) {
      if (!byDay.has(row.day)) byDay.set(row.day, []);
      byDay.get(row.day).push(row);
    }

    const signature = rows
      .map((row) => [row.day, row.name, row.amountText, row.status, row.schedule].join('::'))
      .join('|');
    if (calendar.dataset.detailSignature === signature) return;
    calendar.dataset.detailSignature = signature;

    const selected = selectedCalendarDay(center, rows);
    if (selected) center.dataset.selectedBillDay = String(selected);

    center.querySelectorAll('.bill-day').forEach((cell) => {
      const day = Number(cell.querySelector('.bill-day-num')?.textContent || 0);
      if (!day) return;
      const dayRows = byDay.get(day) ?? [];
      const due = dayRows.filter((row) => row.status === 'due');
      const paid = dayRows.filter((row) => row.status === 'paid');

      cell.querySelectorAll('.bill-calendar-mini').forEach((node) => node.remove());
      cell.classList.toggle('selected', day === selected);
      cell.setAttribute('role', 'button');
      cell.tabIndex = 0;

      if (due.length) {
        const mini = document.createElement('span');
        mini.className = 'bill-calendar-mini due';
        mini.textContent = due.length === 1
          ? `${compactMoney(due[0].amount)} due`
          : `${due.length} due`;
        cell.appendChild(mini);
      }

      if (paid.length) {
        const paidTotal = paid.reduce((sum, row) => sum + row.amount, 0);
        const mini = document.createElement('span');
        mini.className = 'bill-calendar-mini paid';
        mini.textContent = paid.length === 1
          ? `✓ ${compactMoney(paid[0].amount)}`
          : `✓ ${paid.length} paid`;
        mini.title = `${compactMoney(paidTotal)} paid`;
        cell.appendChild(mini);
      }

      const selectDay = () => {
        center.dataset.selectedBillDay = String(day);
        center.querySelectorAll('.bill-day').forEach((node) => node.classList.remove('selected'));
        cell.classList.add('selected');
        renderCalendarAgenda(center, day, rows);
      };

      if (cell.dataset.calendarDetailBound !== '1') {
        cell.addEventListener('click', selectDay);
        cell.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            selectDay();
          }
        });
        cell.dataset.calendarDetailBound = '1';
      }

      const dueText = due.length ? `${due.length} due` : '';
      const paidText = paid.length ? `${paid.length} paid` : '';
      cell.setAttribute(
        'aria-label',
        [`Day ${day}`, dueText, paidText].filter(Boolean).join(', '),
      );
    });

    if (selected) renderCalendarAgenda(center, selected, rows);
  };

  const polishBillsCenter = () => {
    const center = document.querySelector('[data-bill-center]');
    if (!center) return;
    center.querySelectorAll('.bill-center-row').forEach(enrichBillRow);
    polishBillsCalendar(center);
  };

  const simplify = () => {
    ensureStyle();

    // Bills are the primary household obligation view. The monthly plan stays
    // one tap away, but the bottom nav no longer drops people into a second,
    // partly duplicated bill list first.
    const primary = document.querySelector('.tabbar .tab[data-view="budget"]');
    if (primary) {
      primary.dataset.view = 'bills';
      setOwnText(primary, 'Bills');
    }

    // Spending answers a different time question than Bills. Bills is what is
    // coming due; Spending is what actually left the account in the selected
    // month. Give the section its honest name so two correct lists do not look
    // like conflicting data.
    const spendingSeg = [...document.querySelectorAll('main .seg')].find(
      (seg) => seg.querySelector('.seg-btn[data-view="spending"].active'),
    );
    if (spendingSeg) {
      renameSection(
        'Bills',
        'Bills paid this month',
        'Actual recurring household bills that cleared from the account.',
      );
    }

    const budgetSeg = [...document.querySelectorAll('main .seg')].find(
      (seg) => seg.querySelector('.seg-btn[data-view="budget"]')
        && seg.querySelector('.seg-btn[data-view="bills"]'),
    );
    if (!budgetSeg) return;

    const monthlyBtn = budgetSeg.querySelector('.seg-btn[data-view="budget"]');
    const billsBtn = budgetSeg.querySelector('.seg-btn[data-view="bills"]');

    setText(monthlyBtn, 'Monthly plan');
    setText(billsBtn, 'Bills');

    if (budgetSeg.firstElementChild !== billsBtn) budgetSeg.insertBefore(billsBtn, monthlyBtn);

    const billsActive = billsBtn.classList.contains('active');
    const monthlyActive = monthlyBtn.classList.contains('active');
    const headerTitle = document.querySelector('.app-bar-title');
    const headerSub = document.querySelector('.app-bar-sub');

    if (billsActive) {
      setText(headerTitle, 'Bills');
      setText(headerSub, 'What is paid, what is still due, and which paycheck covers it.');

      renameSection(
        'Which check covers what',
        'Bills by paycheck',
        'Each bill goes with the paycheck that needs to cover it.',
      );
      renameSection(
        'Found in your transactions',
        'Bills the app found',
        'Recurring charges detected automatically from your transactions.',
      );
      renameSection(
        'Needs review',
        'Check these bills',
        'The app found these, but wants a quick confirmation before counting them.',
      );

      const addBill = [...document.querySelectorAll('[data-action="toggle-bill-form"]')]
        .find((button) => button.textContent.includes('Add a bill by hand'));
      if (addBill) {
        const icon = addBill.querySelector('svg');
        addBill.textContent = '';
        if (icon) addBill.appendChild(icon);
        addBill.appendChild(document.createTextNode('Add bill'));
      }

      // Replace the old "total here / paycheck list there / subscriptions in
      // More" mental merge with one operational summary. Import lazily so this
      // extra data work happens only when Bills is actually open.
      loadBillsCenter()
        .then((module) => module.enhanceBillsView())
        .then(() => polishBillsCenter())
        .catch(() => { /* The original Bills view remains usable on failure. */ });

      polishBillsCenter();
    }

    if (monthlyActive) {
      setText(headerTitle, 'Monthly plan');
      setText(headerSub, 'Bills plus everyday essentials for this month.');

      const billsSection = sectionByTitle('Bills');
      if (billsSection) billsSection.hidden = true;

      renameSection(
        'Necessities',
        'Everyday essentials',
        'Groceries, gas, utilities and other must-haves without a fixed due date.',
      );

      const heroLabel = document.querySelector('main > .hero .hero-label');
      if (heroLabel?.textContent.trim().startsWith('The plan for ')) {
        setText(heroLabel, heroLabel.textContent.trim().replace('The plan for ', 'Planned for '));
      }
    }
  };

  let queued = false;
  const schedule = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      simplify();
    });
  };

  new MutationObserver(schedule).observe(app, { childList: true, subtree: true });
  schedule();
})();
