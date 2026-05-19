/* au-sidenav — vanilla JS for the OPM-inspired left navigation
 *
 * Responsibilities:
 *   1. On load: collapse all parent items, wire ARIA attrs, mark current page
 *      and expand its ancestor chain.
 *   2. Click: toggle a parent's expanded/collapsed state without navigating.
 *
 * No dependencies. Safe to load multiple times (idempotent init via dataset flag).
 */
(function () {
  "use strict";

  var CLS = {
    nav:          "au-sidenav",
    header:       "au-sidenav__header",
    list:         "au-sidenav__list",
    sublist:      "au-sidenav__sublist",
    item:         "au-sidenav__item",
    toggle:       "au-sidenav__toggle",
    mobileToggle: "au-sidenav__mobile-toggle",
    mobileCollapsed: "au-sidenav--mobile-collapsed",
    collapsed:    "au-sidenav__item--collapsed",
    expanded:     "au-sidenav__item--expanded",
    currentSec:   "au-sidenav__item--current-section",
    currentLink:  "au-sidenav__link--current"
  };

  var MOBILE_MQ = "(max-width: 768px)";

  function normalizePath(p) {
    if (!p) return "";
    try {
      var u = new URL(p, window.location.origin);
      var path = u.pathname.toLowerCase();
      if (path.length > 1 && path.charAt(path.length - 1) !== "/") path += "/";
      return path;
    } catch (e) {
      return p.toLowerCase();
    }
  }

  function getCurrentPath(nav) {
    // Optional override for testing: <nav data-au-current-path="/foo/">
    if (nav.dataset.auCurrentPath) return nav.dataset.auCurrentPath;
    return window.location.pathname;
  }

  function findCurrentLink(nav) {
    var here = normalizePath(getCurrentPath(nav));
    var links = nav.querySelectorAll("." + CLS.list + " a[href]");
    for (var i = 0; i < links.length; i++) {
      if (normalizePath(links[i].getAttribute("href")) === here) {
        return links[i];
      }
    }
    return null;
  }

  function setExpanded(li, expanded) {
    if (!li) return;
    li.classList.toggle(CLS.expanded, expanded);
    li.classList.toggle(CLS.collapsed, !expanded);
    var btn = li.querySelector(":scope > ." + CLS.toggle);
    if (btn) btn.setAttribute("aria-expanded", expanded ? "true" : "false");
  }

  function collapseDescendants(li) {
    var nested = li.querySelectorAll("." + CLS.expanded);
    for (var i = 0; i < nested.length; i++) {
      setExpanded(nested[i], false);
    }
  }

  function initNav(nav) {
    if (nav.dataset.auSidenavInit === "1") return;
    nav.dataset.auSidenavInit = "1";

    // 1. For every <li> that has a sublist, default to collapsed (or expanded
    //    when the authored markup opts in via data-au-default-expanded="true")
    //    and wire up the toggle button + ARIA attrs.
    var idCounter = 0;
    var parentItems = nav.querySelectorAll("." + CLS.item);
    for (var i = 0; i < parentItems.length; i++) {
      var li = parentItems[i];
      var sublist = li.querySelector(":scope > ." + CLS.sublist);
      if (!sublist) continue;

      var startExpanded = li.dataset.auDefaultExpanded === "true";
      li.classList.add(startExpanded ? CLS.expanded : CLS.collapsed);

      var btn = li.querySelector(":scope > ." + CLS.toggle);
      if (btn) {
        if (!sublist.id) sublist.id = "au-sidenav-sub-" + (++idCounter);
        btn.setAttribute("aria-controls", sublist.id);
        btn.setAttribute("aria-expanded", startExpanded ? "true" : "false");
        if (!btn.hasAttribute("aria-label") && !btn.textContent.trim()) {
          btn.setAttribute("aria-label", "Toggle submenu");
        }
      }
    }

    // 1a. Wrap the h3 text in a button so the heading row is a tap target
    //     for the mobile inline-accordion. The CSS keeps it visually identical
    //     to a plain h3 above the breakpoint; below the breakpoint a chevron
    //     appears and the click handler hides/shows the list.
    var header = nav.querySelector(":scope > ." + CLS.header);
    var rootList = nav.querySelector(":scope > ." + CLS.list);
    if (header && rootList && !header.querySelector("." + CLS.mobileToggle)) {
      if (!rootList.id) rootList.id = "au-sidenav-root-" + (++idCounter);
      var labelText = header.textContent;
      header.textContent = "";
      var mbtn = document.createElement("button");
      mbtn.type = "button";
      mbtn.className = CLS.mobileToggle;
      mbtn.setAttribute("aria-controls", rootList.id);
      mbtn.setAttribute("aria-expanded", "false");
      mbtn.textContent = labelText;
      header.appendChild(mbtn);
      nav.classList.add(CLS.mobileCollapsed);
    }

    // 1b. Tag each sublist with its nesting depth so CSS can compute
    //     padding-left: depth 1 = first sublist, 2 = grandchild, etc.
    var sublists = nav.querySelectorAll("." + CLS.sublist);
    for (var s = 0; s < sublists.length; s++) {
      var ul = sublists[s], depth = 0, n = ul;
      while ((n = n.parentElement) && nav.contains(n)) {
        if (n.classList.contains(CLS.sublist)) depth++;
      }
      ul.style.setProperty("--depth", depth + 1);
    }

    // 2. Detect the current page and walk up the ancestor chain.
    var currentLink = findCurrentLink(nav);
    if (currentLink) {
      currentLink.classList.add(CLS.currentLink);

      var li = currentLink.closest("." + CLS.item);
      // If the current link is itself a parent, expand its own sublist too.
      if (li && li.querySelector(":scope > ." + CLS.sublist)) {
        setExpanded(li, true);
      }
      // Walk up: every ancestor <li> in this nav gets the current-section
      // modifier and is expanded.
      var node = li;
      while (node && nav.contains(node)) {
        node.classList.add(CLS.currentSec);
        if (node.querySelector(":scope > ." + CLS.sublist)) {
          setExpanded(node, true);
        }
        var parent = node.parentElement;
        node = parent ? parent.closest("." + CLS.item) : null;
      }
    }

    // 3. Delegated click handler for toggle buttons. Bound once per nav,
    //    tracked separately from the init flag so callers can clear init
    //    and re-run state setup without stacking duplicate click handlers
    //    on every re-init.
    if (nav.dataset.auSidenavBound !== "1") {
      nav.dataset.auSidenavBound = "1";
      nav.addEventListener("click", function (e) {
        // Mobile accordion toggle (inert above the breakpoint — h3 is just a heading)
        var mbtn = e.target.closest("." + CLS.mobileToggle);
        if (mbtn && nav.contains(mbtn)) {
          if (!window.matchMedia(MOBILE_MQ).matches) return;
          e.preventDefault();
          var nowCollapsed = nav.classList.toggle(CLS.mobileCollapsed);
          mbtn.setAttribute("aria-expanded", nowCollapsed ? "false" : "true");
          return;
        }
        var btn = e.target.closest("." + CLS.toggle);
        if (!btn || !nav.contains(btn)) return;
        e.preventDefault();
        var li = btn.closest("." + CLS.item);
        if (!li) return;
        var isExpanded = li.classList.contains(CLS.expanded);
        if (isExpanded) {
          collapseDescendants(li);
          setExpanded(li, false);
        } else {
          setExpanded(li, true);
        }
      });
    }
  }

  function initAll() {
    var navs = document.querySelectorAll("." + CLS.nav);
    for (var i = 0; i < navs.length; i++) initNav(navs[i]);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initAll);
  } else {
    initAll();
  }

  // Expose for manual re-init (e.g. after DNN AJAX updates the DOM)
  window.AuSidenav = { init: initAll, initNav: initNav };
})();
