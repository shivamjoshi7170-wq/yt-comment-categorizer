/**
 * content-script.js - Injected On-Page YouTube Comment Categorizer Panel.
 *
 * ARCHITECTURAL DESIGN & RATIONALE:
 *
 * 1. Injected On-Page Panel (No Popups):
 *    - Instead of requiring users to click an extension icon in the toolbar,
 *      this script mounts an interactive panel directly into YouTube's DOM,
 *      positioned at the top of the comments section.
 *    - By embedding directly within `ytd-comments#comments`, the panel flows
 *      naturally with YouTube's responsive page layout across standard, theater,
 *      and mobile/narrow viewport widths, avoiding overlay conflicts with video playback.
 *
 * 2. YouTube Single-Page-Application (SPA) Navigation Handling (`yt-navigate-finish`):
 *    - WHY: YouTube does not reload the entire browser page when a user clicks another video;
 *      instead, it swaps player and comment content via client-side JavaScript.
 *    - Standard `DOMContentLoaded` or window `load` events only fire on the very first page visit!
 *    - YouTube fires a custom event `yt-navigate-finish` on `window` whenever a client-side
 *      route transition completes.
 *    - On `yt-navigate-finish`, we clean up old observers, clear `commentMap` and counters,
 *      remove the previous video's panel, and mount a fresh observer and panel for the new video.
 *
 * 3. Non-Intrusive MutationObserver on Lazy-Loaded Comments:
 *    - WHY: YouTube does not load all comments at once. As the user scrolls down,
 *      YouTube's virtual list streams batches of `<ytd-comment-thread-renderer>` elements.
 *    - We NEVER force-scroll or auto-fetch. We attach a `MutationObserver` specifically to
 *      the comments container to classify new comments as they are naturally rendered.
 *    - To avoid layout thrashing during fast scroll batches, panel re-renders are batched
 *      via `requestAnimationFrame`.
 *
 * 4. Zero Duplicate Text Storage & O(1) Memory State:
 *    - Full comment text is NEVER retained in JavaScript memory.
 *    - State is strictly maintained as:
 *      - `commentMap`: Map<Element, string> (threadNode -> categoryLabel)
 *      - `categoryCounts`: Fixed 6-key numeric object.
 *    - Snippets are retrieved on-demand directly from the live DOM node (`#content-text`),
 *      capped at 5 items per category and truncated to 85 characters.
 */
console.log("YT Categorizer v2: content script running");
(function () {
  'use strict';

  // Category metadata for consistent UI ordering, icons, and styling
  const CATEGORY_CONFIG = [
    { key: 'Questions', label: 'Questions', icon: '❓', badgeClass: 'badge-questions' },
    { key: 'Suggestions', label: 'Suggestions', icon: '💡', badgeClass: 'badge-suggestions' },
    { key: 'Feedback', label: 'Feedback', icon: '📝', badgeClass: 'badge-feedback' },
    { key: 'Praise', label: 'Praise', icon: '⭐', badgeClass: 'badge-praise' },
    { key: 'Spam', label: 'Spam', icon: '🚫', badgeClass: 'badge-spam' },
    { key: 'Other', label: 'Other', icon: '💬', badgeClass: 'badge-other' }
  ];

  const PANEL_ID = 'yt-comment-categorizer-panel';
  const MAX_SNIPPETS_PER_CATEGORY = 5;
  const MAX_SNIPPET_LENGTH = 85;

  /**
   * STATE MANAGEMENT:
   * - commentMap: Maps DOM Element (ytd-comment-thread-renderer) -> category string label.
   *   O(1) lookup per comment. Strings are interned by V8 engine. No duplicate text stored.
   * - categoryCounts: Fixed numeric tallies for each bucket.
   */
  const commentMap = new Map();
  const categoryCounts = {
    Questions: 0,
    Suggestions: 0,
    Feedback: 0,
    Praise: 0,
    Spam: 0,
    Other: 0
  };
  let totalComments = 0;

  // Active UI states
  let activeSnippetCategory = null;
  let isPanelCollapsed = false;

  // Observers and timers
  let commentsObserver = null;
  let containerWatcherTimer = null;
  let renderFrameRequested = false;

  /**
   * REUSABLE FUNCTION: resetStateAndPanel()
   * Cleans up all state and DOM artifacts from the previous video.
   *
   * WHY:
   * When navigating between videos on YouTube's SPA, stale comment references
   * and previous DOM panel elements must be purged to avoid memory leaks
   * and cross-video data contamination.
   */
  function resetStateAndPanel() {
    // 1. Clear comment tracking state
    commentMap.clear();
    for (const config of CATEGORY_CONFIG) {
      categoryCounts[config.key] = 0;
    }
    totalComments = 0;
    activeSnippetCategory = null;

    // 2. Disconnect existing observers and timers
    if (commentsObserver) {
      commentsObserver.disconnect();
      commentsObserver = null;
    }
    if (containerWatcherTimer) {
      clearInterval(containerWatcherTimer);
      containerWatcherTimer = null;
    }
    renderFrameRequested = false;

    // 3. Remove existing panel from DOM if present
    const existingPanel = document.getElementById(PANEL_ID);
    if (existingPanel) {
      existingPanel.remove();
    }
  }

  /**
   * Helper: Extracts live text snippet on-demand from connected DOM elements.
   *
   * WHY:
   * We do NOT store full comment text in memory. Snippets are read directly
   * from the live DOM node only when a category is expanded by the user,
   * capped to 5 short strings.
   *
   * @param {string} category
   * @returns {string[]}
   */
  function getLiveSnippetsForCategory(category) {
    const snippets = [];

    for (const [threadNode, cat] of commentMap.entries()) {
      if (cat === category && threadNode.isConnected) {
        const textEl = threadNode.querySelector('#content-text');
        if (textEl) {
          const raw = textEl.textContent.trim().replace(/\s+/g, ' ');
          if (raw) {
            const snippet = raw.length > MAX_SNIPPET_LENGTH
              ? raw.slice(0, MAX_SNIPPET_LENGTH) + '…'
              : raw;
            snippets.push(snippet);

            if (snippets.length >= MAX_SNIPPETS_PER_CATEGORY) {
              break;
            }
          }
        }
      }
    }

    return snippets;
  }

  /**
   * REUSABLE FUNCTION: renderPanel()
   * Synchronizes the injected panel UI with current category counts and snippet state.
   *
   * WHY:
   * Kept separate from DOM injection so it can be called repeatedly whenever
   * new comments are classified without re-creating the entire panel DOM.
   */
  function renderPanel() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) {
      return;
    }

    // 1. Update total counter badge
    const totalBadge = panel.querySelector('#ytcc-total-count');
    if (totalBadge) {
      totalBadge.textContent = `${totalComments} scanned`;
    }

    // 2. Update status hint if no comments scanned yet
    const statusEl = panel.querySelector('#ytcc-status-message');
    if (statusEl) {
      if (totalComments === 0) {
        statusEl.textContent = 'Comments section ready. Scroll down on YouTube to stream and categorize comments.';
        statusEl.style.display = 'block';
      } else {
        statusEl.style.display = 'none';
      }
    }

    // 3. Update category card counts & active states
    CATEGORY_CONFIG.forEach((config) => {
      const count = categoryCounts[config.key] || 0;
      const countEl = panel.querySelector(`#ytcc-count-${config.key}`);
      if (countEl) {
        countEl.textContent = count;
      }

      const cardEl = panel.querySelector(`#ytcc-card-${config.key}`);
      if (cardEl) {
        if (activeSnippetCategory === config.key) {
          cardEl.classList.add('active');
        } else {
          cardEl.classList.remove('active');
        }
      }
    });

    // 4. Update expandable snippets drawer
    const drawerEl = panel.querySelector('#ytcc-snippets-drawer');
    const drawerTitleEl = panel.querySelector('#ytcc-drawer-title');
    const drawerListEl = panel.querySelector('#ytcc-drawer-list');

    if (drawerEl && drawerTitleEl && drawerListEl) {
      if (activeSnippetCategory) {
        drawerEl.classList.add('open');
        drawerTitleEl.textContent = `${activeSnippetCategory} Preview (Capped at ${MAX_SNIPPETS_PER_CATEGORY})`;
        drawerListEl.innerHTML = '';

        const snippets = getLiveSnippetsForCategory(activeSnippetCategory);
        if (snippets.length === 0) {
          const emptyMsg = document.createElement('div');
          emptyMsg.className = 'ytcc-snippet-empty';
          emptyMsg.textContent = categoryCounts[activeSnippetCategory] === 0
            ? 'No comments in this category yet.'
            : 'Comments in this category are loading or scrolled out of view.';
          drawerListEl.appendChild(emptyMsg);
        } else {
          snippets.forEach((snippet) => {
            const item = document.createElement('div');
            item.className = 'ytcc-snippet-item';
            item.textContent = `"${snippet}"`;
            drawerListEl.appendChild(item);
          });
        }
      } else {
        drawerEl.classList.remove('open');
      }
    }

    // 5. Update collapse state
    panel.classList.toggle('collapsed', isPanelCollapsed);
    const collapseBtn = panel.querySelector('#ytcc-collapse-btn');
    if (collapseBtn) {
      collapseBtn.textContent = isPanelCollapsed ? '➕ Expand' : '➖ Collapse';
    }
  }

  /**
   * Batches UI rendering using requestAnimationFrame.
   *
   * WHY:
   * When YouTube appends 20 comments at once during scrolling, calling
   * renderPanel() synchronously 20 times causes layout thrashing.
   * Debouncing to the next animation frame ensures smooth 60fps rendering.
   */
  function scheduleRender() {
    if (renderFrameRequested) return;
    renderFrameRequested = true;
    requestAnimationFrame(() => {
      renderFrameRequested = false;
      renderPanel();
    });
  }

  /**
   * REUSABLE FUNCTION: injectOrGetPanel()
   * Creates and mounts the categorizer panel DOM directly into YouTube's comments tree.
   *
   * WHY:
   * Inserting into `ytd-comments#comments` (right after the `#header` renderer, or prepended)
   * ensures the panel remains positioned with the comments, automatically responsive
   * to YouTube's column layouts, and never covers video controls or sidebars.
   *
   * @param {Element} commentsContainer - The <ytd-comments id="comments"> container.
   * @returns {Element} The panel DOM element.
   */
  function injectOrGetPanel(commentsContainer) {
    let panel = document.getElementById(PANEL_ID);

    if (panel) {
      
      return panel;
    }

    panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.innerHTML = `
      <div class="ytcc-header">
        <div class="ytcc-title-area">
          <span class="ytcc-logo">📊</span>
          <span class="ytcc-title">YT Comment Categorizer</span>
          <span id="ytcc-total-count" class="ytcc-total-badge">0 scanned</span>
        </div>
        <div class="ytcc-controls">
          <button id="ytcc-rescan-btn" class="ytcc-btn" title="Rescan visible comments">🔄 Rescan</button>
          <button id="ytcc-collapse-btn" class="ytcc-btn" title="Toggle panel view">➖ Collapse</button>
        </div>
      </div>

      <div id="ytcc-status-message" class="ytcc-status">
        Waiting for comments to load...
      </div>

      <div class="ytcc-categories-grid">
        ${CATEGORY_CONFIG.map(config => `
          <button type="button" class="ytcc-cat-card" id="ytcc-card-${config.key}" data-category="${config.key}">
            <span class="ytcc-cat-label">
              <span>${config.icon}</span>
              <span>${config.label}</span>
            </span>
            <span class="ytcc-cat-count ${config.badgeClass}" id="ytcc-count-${config.key}">0</span>
          </button>
        `).join('')}
      </div>

      <div id="ytcc-snippets-drawer" class="ytcc-snippets-drawer">
        <div class="ytcc-snippets-header">
          <span id="ytcc-drawer-title">Snippets Preview</span>
          <button type="button" id="ytcc-drawer-close" class="ytcc-btn" style="padding: 2px 7px;">✕ Close</button>
        </div>
        <div id="ytcc-drawer-list" class="ytcc-snippets-list"></div>
      </div>
    `;

    // Hook up Event Listeners
    // 1. Category card click -> toggle snippets drawer
    panel.querySelectorAll('.ytcc-cat-card').forEach((card) => {
      card.addEventListener('click', (e) => {
        const catKey = card.getAttribute('data-category');
        activeSnippetCategory = (activeSnippetCategory === catKey) ? null : catKey;
        renderPanel();
      });
    });

    // 2. Close snippets drawer
    const drawerCloseBtn = panel.querySelector('#ytcc-drawer-close');
    if (drawerCloseBtn) {
      drawerCloseBtn.addEventListener('click', () => {
        activeSnippetCategory = null;
        renderPanel();
      });
    }

    // 3. Collapse/Expand button
    const collapseBtn = panel.querySelector('#ytcc-collapse-btn');
    if (collapseBtn) {
      collapseBtn.addEventListener('click', () => {
        isPanelCollapsed = !isPanelCollapsed;
        renderPanel();
      });
    }

    // 4. Rescan button
    const rescanBtn = panel.querySelector('#ytcc-rescan-btn');
    if (rescanBtn) {
      rescanBtn.addEventListener('click', () => {
        scanComments(commentsContainer);
        renderPanel();
      });
    }

    // MOUNT STRATEGY:
    // Place right after <ytd-comments-header-renderer id="header"> if present,
    // otherwise prepend to the commentsContainer.
    const headerRenderer = commentsContainer.querySelector('ytd-comments-header-renderer#header, #header');
    // The header renderer may be nested below commentsContainer. Insert beside
    // it in its own parent so the panel stays directly below the header.
    if (headerRenderer?.parentNode) {
      headerRenderer.parentNode.insertBefore(panel, headerRenderer.nextSibling);
    } else {
      commentsContainer.prepend(panel);
    }
    console.log('YTCC_DEBUG: panel variable at return =', panel);
    renderPanel();
    return panel;
  }

  /**
   * Classifies a single comment thread and updates counts.
   *
   * @param {Element} threadNode - <ytd-comment-thread-renderer>
   * @param {string} text - Raw comment text
   * @returns {boolean} True if new comment was classified
   */
  function recordThreadClassification(threadNode, text) {
    if (commentMap.has(threadNode)) {
      return false; // Prevent double-counting
    }

    // Use pure classify() from classifier.js
    const category = typeof classify === 'function' ? classify(text) : 'Other';

    // Store element reference and category label only (no full text)
    commentMap.set(threadNode, category);

    if (categoryCounts.hasOwnProperty(category)) {
      categoryCounts[category]++;
    } else {
      categoryCounts['Other']++;
    }
    totalComments++;
    return true;
  }

  /**
   * Processes a detected <ytd-comment-thread-renderer> element.
   *
   * WHY:
   * YouTube Web Components often insert the skeleton element first,
   * then render `#content-text` milliseconds later. If `#content-text`
   * is not yet populated, a brief local observer catches it as soon
   * as the text is inserted.
   *
   * @param {Element} threadNode
   * @returns {boolean} True if classified immediately
   */
  function processThreadNode(threadNode) {
    if (!threadNode || commentMap.has(threadNode)) {
      return false;
    }

    const textEl = threadNode.querySelector('#content-text');
    const text = textEl ? textEl.textContent.trim() : '';

    if (text) {
      recordThreadClassification(threadNode, text);
      return true;
    }

    // Text not ready yet: attach short-lived one-shot observer
    const hydrationObserver = new MutationObserver(() => {
      const lateTextEl = threadNode.querySelector('#content-text');
      const lateText = lateTextEl ? lateTextEl.textContent.trim() : '';
      if (lateText) {
        hydrationObserver.disconnect();
        if (recordThreadClassification(threadNode, lateText)) {
          scheduleRender();
        }
      }
    });

    hydrationObserver.observe(threadNode, {
      childList: true,
      subtree: true,
      characterData: true
    });

    // Cleanup timeout in case comment is empty or deleted
    setTimeout(() => hydrationObserver.disconnect(), 4000);
    return false;
  }

  /**
   * REUSABLE FUNCTION: scanComments()
   * Scans a root element or comments container for any new <ytd-comment-thread-renderer> elements.
   *
   * @param {Node} rootNode
   */
  function scanComments(rootNode) {
    if (!rootNode || rootNode.nodeType !== Node.ELEMENT_NODE) {
      return;
    }

    let foundNew = false;

    if (rootNode.tagName === 'YTD-COMMENT-THREAD-RENDERER') {
      if (processThreadNode(rootNode)) {
        foundNew = true;
      }
    } else {
      const threads = rootNode.querySelectorAll('ytd-comment-thread-renderer');
      for (let i = 0; i < threads.length; i++) {
        if (processThreadNode(threads[i])) {
          foundNew = true;
        }
      }
    }

    if (foundNew) {
      scheduleRender();
    }
  }

  /**
   * REUSABLE FUNCTION: setupCommentsObserver()
   * Attaches the main MutationObserver to the comments container.
   *
   * WHY:
   * YouTube virtualizes and lazy-loads comments on scroll into the container.
   * Attaching specifically to the comments container avoids observing unrelated
   * mutations in the video player, recommendations sidebar, or chat.
   *
   * @param {Element} commentsContainer
   */
  function setupCommentsObserver(commentsContainer) {
    if (commentsObserver) {
      commentsObserver.disconnect();
    }

    commentsObserver = new MutationObserver((mutations) => {
      for (let i = 0; i < mutations.length; i++) {
        const addedNodes = mutations[i].addedNodes;
        for (let j = 0; j < addedNodes.length; j++) {
          scanComments(addedNodes[j]);
        }
      }

      // YouTube may replace comment markup after the initial mount. Restore the
      // panel if that update removed it from the still-active comments container.
      if (commentsContainer.isConnected && !document.getElementById(PANEL_ID)) {
        injectOrGetPanel(commentsContainer);
      }
    });

    commentsObserver.observe(commentsContainer, {
      childList: true,
      subtree: true
    });
  }

  /**
   * REUSABLE FUNCTION: initCategorizer()
   * Main entry point to detect comments container, inject panel, scan existing comments,
   * and attach observers.
   *
   * WHY:
   * On YouTube watch pages, the comments container (#comments) is often lazy-mounted
   * only when the user scrolls towards the comments section. We poll periodically
   * until it exists, inject the panel, run initial scans, and activate the observer.
   */
  function initCategorizer() {
    if (!window.location.pathname.startsWith('/watch')) {
      resetStateAndPanel();
      return;
    }

    const tryMount = () => {
      console.log('tryMount called');
      

      const commentsContainer = document.querySelector('ytd-comments#comments, #comments');
      console.log('commentsContainer found:', commentsContainer);
      if (commentsContainer) {
        if (containerWatcherTimer) {
          clearInterval(containerWatcherTimer);
          containerWatcherTimer = null;
        }

        // 1. Inject or locate panel
        injectOrGetPanel(commentsContainer);

        // 2. Scan any comments already present in the DOM
        scanComments(commentsContainer);

        // 3. Render initial panel state
        renderPanel();

        // 4. Attach MutationObserver for lazy-loaded comments
        setupCommentsObserver(commentsContainer);
        return true;
      }
      return false;
    };

    if (!tryMount()) {
      // Poll every 600ms until YouTube attaches the comments container
      if (containerWatcherTimer) {
        clearInterval(containerWatcherTimer);
      }
      containerWatcherTimer = setInterval(tryMount, 600);
    }
  }

  /**
   * SPA NAVIGATION LISTENER: yt-navigate-finish
   *
   * WHY:
   * When navigating between videos on YouTube, YouTube does NOT reload the page.
   * It fires its own custom DOM event: `yt-navigate-finish`.
   * On this event, we must reset the old panel and state, and run initCategorizer()
   * fresh for the new video WITHOUT forcing a browser page reload.
   */
  window.addEventListener('yt-navigate-finish', () => {
    resetStateAndPanel();

    if (window.location.pathname.startsWith('/watch')) {
      initCategorizer();
    }
  });

  // Initial trigger on script evaluation
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initCategorizer);
  } else {
    initCategorizer();
  }
})();
