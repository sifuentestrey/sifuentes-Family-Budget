(() => {
  const app = document.getElementById('app');
  if (!app) return;

  let scheduled = false;

  const icons = {
    home: '<path d="M3 9.5 10 4l7 5.5V16a1 1 0 0 1-1 1h-3.5v-4.5h-5V17H4a1 1 0 0 1-1-1z"/>',
    plan: '<rect x="3" y="4.5" width="14" height="12.5" rx="1.5"/><path d="M3 8.5h14M7 3v3M13 3v3"/><path d="M6.5 12h2M11.5 12h2"/>',
    spending: '<path d="M3 15.5 7.5 10l3.2 3 5.3-6.5"/><path d="M12.5 6.5H16V10"/>',
    budget: '<rect x="2.5" y="5.5" width="15" height="10" rx="2"/><path d="M2.5 9h15"/><path d="M13 12.5h2"/>',
    more: '<circle cx="5" cy="10" r="1.3" fill="currentColor" stroke="none"/><circle cx="10" cy="10" r="1.3" fill="currentColor" stroke="none"/><circle cx="15" cy="10" r="1.3" fill="currentColor" stroke="none"/>',
    income: '<path d="M10 3.5v13"/><path d="M13.2 6.2A3 3 0 0 0 10.4 4.5h-.8a2.6 2.6 0 0 0-.4 5.2l1.6.3a2.6 2.6 0 0 1-.4 5.2h-.8a3 3 0 0 1-2.8-1.7"/>',
  };

  const svg = (name, size = 21) => `<svg width="${size}" height="${size}" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]}</svg>`;

  /**
   * Route through an existing app-owned tab button. app.js reads dataset.view
   * at click time, so this reaches the real router without inventing a second
   * state machine. The temporary value disappears with the next app render.
   */
  function routeTo(view) {
    const tab = document.querySelector('.tabbar .tab');
    if (!tab) return;
    tab.dataset.view = view;
    tab.click();
  }
  window.__familyBudgetRoute = routeTo;

  function activeView() {
    const activeSeg = document.querySelector('main .seg-btn.active')?.dataset.view;
    if (activeSeg) return activeSeg;
    const title = document.querySelector('.app-bar-title')?.textContent.trim() ?? '';
    if (title === 'Home') return 'dashboard';
    if (title === 'Spending') return 'spending';
    if (title === 'Budget') return 'budget';
    if (title === 'Bills' || title === 'Plan') return 'bills';
    if (title === 'Income') return 'income';
    if (['Settings', 'More', 'Accounts', 'Advisor', 'Recurring', 'Trends'].includes(title)) return 'more';
    return null;
  }

  function setHeader(title, sub) {
    const titleNode = document.querySelector('.app-bar-title');
    const subNode = document.querySelector('.app-bar-sub');
    if (titleNode && titleNode.textContent !== title) titleNode.textContent = title;
    if (subNode && subNode.textContent !== sub) subNode.textContent = sub;
  }

  function setTab(tab, view, label, iconName) {
    if (!tab) return;
    if (tab.dataset.view !== view) tab.dataset.view = view;
    const hasDot = Boolean(tab.querySelector('.tab-dot'));
    const signature = `${view}|${label}|${iconName}|${hasDot ? 1 : 0}`;
    if (tab.dataset.simpleShellSignature === signature) return;
    const dot = hasDot ? '<span class="tab-dot"></span>' : '';
    tab.innerHTML = `<span class="tab-icon">${svg(iconName)}</span>${label}${dot}`;
    tab.dataset.simpleShellSignature = signature;
  }

  /**
   * budget-clarity.js predates this primary IA and intentionally rewrites the
   * bottom tab with data-view="budget" into Bills. Giving the new Budget tab
   * a private DOM route keeps that legacy enhancer from seeing it. A capture
   * listener then forwards the tap into app.js's real `budget` view before the
   * old bubble listener can interpret the private route.
   */
  function bindBudgetPrimary(tab) {
    if (!tab || tab.dataset.simpleBudgetPrimaryBound === '1') return;
    tab.dataset.simpleBudgetPrimaryBound = '1';
    tab.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      routeTo('budget');
    }, true);
  }

  function polishNav(view) {
    const tabs = [...document.querySelectorAll('.tabbar .tab')];
    if (tabs.length !== 5) return;

    setTab(tabs[0], 'dashboard', 'Home', 'home');
    setTab(tabs[1], 'bills', 'Plan', 'plan');
    setTab(tabs[2], 'spending', 'Spending', 'spending');
    setTab(tabs[3], 'simple-budget-primary', 'Budget', 'budget');
    bindBudgetPrimary(tabs[3]);
    setTab(tabs[4], 'more', 'Accounts', 'more');

    const activeIndex = view === 'dashboard' ? 0
      : view === 'bills' ? 1
        : ['spending', 'transactions', 'review', 'year'].includes(view) ? 2
          : view === 'budget' ? 3
            : 4;
    tabs.forEach((tab, index) => tab.classList.toggle('active', index === activeIndex));
  }

  function hideBudgetSegment(view) {
    const segment = [...document.querySelectorAll('main .seg')].find((seg) =>
      seg.querySelector('.seg-btn[data-view="budget"]') && seg.querySelector('.seg-btn[data-view="bills"]'),
    );
    if (segment) segment.hidden = view === 'budget' || view === 'bills';
  }

  function polishSpending() {
    const active = document.querySelector('main .seg-btn[data-view="spending"].active');
    if (!active) return;
    setHeader('Spending', 'Bills & utilities, flexible spending and transactions.');

    const heroLabel = document.querySelector('main .hero .hero-label');
    if (heroLabel && /^Out the door in /i.test(heroLabel.textContent.trim())) {
      heroLabel.textContent = heroLabel.textContent.replace(/^Out the door in /i, 'Spent in ');
    }

    for (const section of document.querySelectorAll('main .section')) {
      const title = section.querySelector('.section-title');
      const sub = section.querySelector('.section-sub');
      if (!title) continue;
      const text = title.textContent.trim();
      if (text === 'Bills' || text === 'Bills paid this month') {
        title.textContent = 'Bills & utilities';
        if (sub && sub.textContent !== 'Recurring household costs that actually cleared this month.') {
          sub.textContent = 'Recurring household costs that actually cleared this month.';
        }
      } else if (text === 'After the bills') {
        title.textContent = 'Spending';
        if (sub && sub.textContent !== 'Everything else that left the account this month.') {
          sub.textContent = 'Everything else that left the account this month.';
        }
      }
    }
  }

  function injectIncomeInMore(view) {
    if (view !== 'more') return;
    setHeader('Accounts', 'Connected accounts, household members, and income sources.');
    const section = [...document.querySelectorAll('main .section')]
      .find((node) => node.querySelector('.section-title')?.textContent.trim() === 'More');
    const list = section?.querySelector('.list');
    if (!list || list.querySelector('[data-simple-income-row]')) return;

    const button = document.createElement('button');
    button.className = 'row';
    button.type = 'button';
    button.dataset.simpleIncomeRow = '1';
    button.innerHTML = `
      <div class="row-avatar ghost">${svg('income', 17)}</div>
      <div class="row-body">
        <div class="row-title">Income & paychecks</div>
        <div class="row-sub">Paydays, paycheck forecast, shifts and paystubs</div>
      </div>
      <span class="row-chev">›</span>`;
    button.addEventListener('click', () => routeTo('income'));
    list.insertBefore(button, list.firstChild);
  }

  function polishHome(view) {
    if (view !== 'dashboard') return;
    setHeader('Home', 'What needs attention, checking, and next payday.');

    // Forecasting belongs in Plan. Home should stay factual and familiar.
    const cards = [...document.querySelectorAll('main .card')];
    for (const card of cards) {
      const title = card.querySelector('.card-title')?.textContent.trim() ?? '';
      if (title.startsWith('Free to spend until')) {
        card.hidden = true;
        const next = card.nextElementSibling;
        if (next?.matches('details.fold') && /Where this number comes from/i.test(next.textContent)) next.hidden = true;
      }
    }
  }

  function polishPlan(view) {
    if (view !== 'bills') return;
    setHeader('Plan', 'Paydays, bills, subscriptions, and what each check needs to cover.');
  }

  function polishBudget(view) {
    if (view !== 'budget') return;
    setHeader('Budget', 'Monthly categories, with flexible ranges when costs move.');
  }

  function run() {
    const view = activeView();
    if (!view) return;
    polishNav(view);
    hideBudgetSegment(view);
    polishHome(view);
    polishPlan(view);
    polishBudget(view);
    polishSpending();
    injectIncomeInMore(view);
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      run();
    });
  }

  new MutationObserver(schedule).observe(app, { childList: true, subtree: true });
  schedule();
})();
