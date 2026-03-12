(function initAppShell() {
  const mobileQuery = window.matchMedia("(max-width: 840px)");
  const body = document.body;
  const sidebar = document.getElementById("primary-nav");
  const menuToggle = document.querySelector("[data-nav-toggle]");
  const backdrop = document.querySelector("[data-nav-backdrop]");

  if (!body || !sidebar || !menuToggle || !backdrop) return;

  let restoreFocusEl = null;

  const getFocusable = () => {
    const selector = [
      "a[href]",
      "button:not([disabled])",
      "input:not([disabled])",
      "select:not([disabled])",
      "textarea:not([disabled])",
      "[tabindex]:not([tabindex='-1'])",
    ].join(",");
    return Array.from(sidebar.querySelectorAll(selector)).filter(
      (el) => el instanceof HTMLElement && !el.hasAttribute("hidden")
    );
  };

  const isOpen = () => body.classList.contains("nav-open");

  const setExpanded = (value) => {
    menuToggle.setAttribute("aria-expanded", value ? "true" : "false");
  };

  const openNav = () => {
    if (!mobileQuery.matches) return;
    if (isOpen()) return;
    restoreFocusEl = document.activeElement instanceof HTMLElement ? document.activeElement : menuToggle;
    body.classList.add("nav-open");
    setExpanded(true);
    const focusable = getFocusable();
    if (focusable.length) {
      focusable[0].focus();
    } else {
      sidebar.focus();
    }
  };

  const closeNav = ({ restoreFocus = true } = {}) => {
    if (!isOpen()) return;
    body.classList.remove("nav-open");
    setExpanded(false);
    if (restoreFocus && restoreFocusEl instanceof HTMLElement) {
      restoreFocusEl.focus();
    }
  };

  menuToggle.addEventListener("click", () => {
    if (isOpen()) {
      closeNav();
      return;
    }
    openNav();
  });

  backdrop.addEventListener("click", () => closeNav({ restoreFocus: false }));

  sidebar.addEventListener("click", (event) => {
    const link = event.target.closest("a[href]");
    if (!link) return;
    closeNav({ restoreFocus: false });
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && isOpen()) {
      event.preventDefault();
      closeNav();
      return;
    }

    if (event.key !== "Tab" || !isOpen()) return;
    const focusable = getFocusable();
    if (!focusable.length) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;

    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
      return;
    }
    if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  });

  const syncForViewport = () => {
    if (mobileQuery.matches) return;
    closeNav({ restoreFocus: false });
  };

  if (typeof mobileQuery.addEventListener === "function") {
    mobileQuery.addEventListener("change", syncForViewport);
  } else if (typeof mobileQuery.addListener === "function") {
    mobileQuery.addListener(syncForViewport);
  }

  syncForViewport();
})();
