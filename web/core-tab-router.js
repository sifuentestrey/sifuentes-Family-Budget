(() => {
  const app = document.getElementById('app');
  if (!app) return;

  // The visual primary navigation is fixed by position. Older enhancement
  // scripts may still rename or temporarily rewrite data-view attributes, but
  // a tap on the fourth tab must always mean Budget, etc. Keeping this map at
  // the capture boundary prevents those presentation layers from becoming a
  // second router.
  const PRIMARY_VIEWS = ['dashboard', 'bills', 'spending', 'budget', 'more'];

  /**
   * Send a view change through an element app.js already owns.
   *
   * app.js attaches its navigation listener to every [data-view] element on
   * each render. Using a non-tab bridge means we invoke that real state change
   * without mutating a primary tab and without depending on which enhancer ran
   * first. The bridge is replaced by the resulting render, so its temporary
   * data-view value cannot leak into later navigation.
   */
  function route(view) {
    if (!view) return false;

    // Prefer a control that already carries the requested destination.
    // The old generic app-bar fallback could route Bills through whatever
    // planning control happened to be rendered first.
    const bridge = document.querySelector(`main [data-view="${view}"]:not(.tab)`)
      || document.querySelector(`.app-bar [data-view="${view}"]`)
      || document.querySelector(`main [data-view="${view}"]`)
      || document.querySelector('.app-bar [data-view]')
      || document.querySelector('main [data-view]:not(.seg-btn)')
      || document.querySelector('main .seg-btn[data-view]');
    if (!bridge) return false;

    bridge.dataset.view = view;
    bridge.click();
    return true;
  }

  // Home/Plan/Budget enhancement modules call this when their own rows link to
  // another section. Override the earlier shell shim so those links use the
  // same app-owned routing path as the bottom tabs.
  window.__familyBudgetRoute = route;

  app.addEventListener('click', (event) => {
    const tab = event.target.closest?.('.tabbar .tab');
    if (!tab) return;

    const tabs = [...document.querySelectorAll('.tabbar .tab')];
    const index = tabs.indexOf(tab);
    const view = PRIMARY_VIEWS[index];
    if (!view) return;

    // Stop both app.js's original tab handler and any target-level enhancer
    // handler. We immediately route through app.js ourselves using the bridge
    // above, so exactly one state transition happens per tap.
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    route(view);
  }, true);
})();
