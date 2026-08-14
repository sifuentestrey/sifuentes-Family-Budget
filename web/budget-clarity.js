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
    `;
    document.head.appendChild(style);
  };

  const setOwnText = (node, value) => {
    if (!node) return;
    const textNode = [...node.childNodes].find(
      (child) => child.nodeType === Node.TEXT_NODE && child.textContent.trim(),
    );
    if (textNode) {
      if (textNode.textContent.trim() !== value) textNode.textContent = `\n          ${value}\n          `;
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
        .catch(() => { /* The original Bills view remains usable on failure. */ });
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
