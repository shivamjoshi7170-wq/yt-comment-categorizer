/**
 * content-script.js - YouTube Comments DOM Observer & Categorizer.
 *
 * DESIGN & ARCHITECTURE RATIONALE:
 * 1. Memory Efficiency (O(1) beyond one label per comment):
 *    - YouTube videos can receive thousands of comments during long browsing sessions.
 *    - Storing full comment text or DOM copies in JS memory would cause memory bloat and leak.
 *    - Instead, state is maintained as a Map(Element -> categoryLabel) and a static count object.
 *    - Comment text is NEVER duplicated or retained in persistent memory.
 *    - Snippets are generated ON DEMAND when requested by the popup, extracted directly from
 *      the live DOM, and capped to a short fixed length (80 chars) and count (5 per category).
 *
 * 2. Non-Intrusive MutationObserver:
 *    - YouTube lazy-loads comments as the user scrolls. We strictly obey this by NOT
 *      force-scrolling or auto-fetching comment pages.
 *    - A MutationObserver listens specifically to the comments container (`#comments` / `ytd-comments`).
 *    - Whenever new `ytd-comment-thread-renderer` nodes are rendered into the DOM, they are
 *      classified once and recorded in the Map.
 *
 * 3. YouTube SPA (Single Page Application) Resilience:
 *    - YouTube uses client-side navigation (`yt-navigate-finish`). When navigating to a new
 *      video, state and observers are cleanly reset to prevent cross-video count pollution.
 */

console.log("YT Categorizer: content script running");
(function () {
  'use strict';

  // Fixed categories tracked by the extension
  const CATEGORIES = ['Questions', 'Suggestions', 'Feedback', 'Praise', 'Spam', 'Other'];

  // Maximum snippets sent to the popup per category (caps transient payload size)
  const MAX_SNIPPETS_PER_CATEGORY = 5;
  const MAX_SNIPPET_LENGTH = 80;

  /**
   * STATE MANAGEMENT:
   * - commentMap: Maps DOM Element (ytd-comment-thread-renderer) -> category string label.
   *   Why: Using DOM elements as keys gives instant O(1) deduplication check without
   *   needing to parse custom IDs or mutate DOM attributes. String labels in JS engines
   *   are interned, keeping overhead to ~32-64 bytes per comment.
   * - categoryCounts: Fixed object holding numeric tallies.
   *   Why: Gives O(1) count retrieval for popup queries without iterating over the Map.
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

  // Active MutationObserver on the comments section
  let commentsObserver = null;
  // Interval/observer for detecting when the comments container appears in the DOM
  let containerWatcher = null;

  /**
   * Resets all internal state when navigating between videos.
   * Why: Prevents memory accumulation and incorrect counts from previous videos.
   */
  function resetState() {
    commentMap.clear();
    for (const cat of CATEGORIES) {
      categoryCounts[cat] = 0;
    }
    totalComments = 0;

    if (commentsObserver) {
      commentsObserver.disconnect();
      commentsObserver = null;
    }
    if (containerWatcher) {
      clearInterval(containerWatcher);
      containerWatcher = null;
    }
  }

  /**
   * Classifies a single comment thread node and records it in state.
   * Why: Separated into its own function so it can be called either immediately
   * upon node discovery, or deferred if YouTube hasn't yet rendered the text node.
   *
   * @param {Element} threadNode - The <ytd-comment-thread-renderer> element.
   * @param {string} text - The raw text content of the comment.
   */
  function recordClassification(threadNode, text) {
    if (commentMap.has(threadNode)) {
      return; // Already classified; prevent double-counting
    }

    // Rely on global pure function classify() from classifier.js
    const category = typeof classify === 'function' ? classify(text) : 'Other';

    // Store ONLY the element reference and category label (no text stored)
    commentMap.set(threadNode, category);

    if (categoryCounts.hasOwnProperty(category)) {
      categoryCounts[category]++;
    } else {
      categoryCounts['Other']++;
    }
    totalComments++;
  }

  /**
   * Processes a detected <ytd-comment-thread-renderer> element.
   * Extracts text from `#content-text`. If the text element is not yet populated
   * (due to YouTube's asynchronous Web Component hydration), sets up a brief one-shot
   * observer to capture the text as soon as it appears.
   *
   * @param {Element} threadNode - The candidate comment thread DOM element.
   */
  function processCommentThread(threadNode) {
    if (!threadNode || commentMap.has(threadNode)) {
      return;
    }

    const textEl = threadNode.querySelector('#content-text');
    const text = textEl ? textEl.textContent.trim() : '';

    if (text) {
      // Text is ready: classify and record immediately
      recordClassification(threadNode, text);
    } else {
      // Text element has not yet rendered or is currently empty.
      // Why: YouTube Web Components often insert the container skeleton first,
      // and populate #content-text moments later. A brief local observer catches this.
      const localObserver = new MutationObserver(() => {
        const deferredTextEl = threadNode.querySelector('#content-text');
        const deferredText = deferredTextEl ? deferredTextEl.textContent.trim() : '';
        if (deferredText) {
          localObserver.disconnect();
          recordClassification(threadNode, deferredText);
        }
      });

      localObserver.observe(threadNode, {
        childList: true,
        subtree: true,
        characterData: true
      });

      // Cleanup timeout in case comment is empty or deleted before populating
      setTimeout(() => {
        localObserver.disconnect();
      }, 5000);
    }
  }

  /**
   * Scans a root element (or added node) for any <ytd-comment-thread-renderer> elements.
   * @param {Node} rootNode
   */
  function scanForComments(rootNode) {
    if (!rootNode || rootNode.nodeType !== Node.ELEMENT_NODE) {
      return;
    }

    // Check if the node itself is a comment thread
    if (rootNode.tagName === 'YTD-COMMENT-THREAD-RENDERER') {
      processCommentThread(rootNode);
      return;
    }

    // Check children within the added subtree
    const threads = rootNode.querySelectorAll('ytd-comment-thread-renderer');
    for (let i = 0; i < threads.length; i++) {
      processCommentThread(threads[i]);
    }
  }

  /**
   * Attaches the main MutationObserver to the comments container.
   * Why: Attaching specifically to the comments container (#comments or #contents)
   * minimizes CPU overhead by ignoring video player, sidebar, and layout mutations.
   *
   * @param {Element} container - The comments container element.
   */
  function attachObserverToComments(container) {
    if (commentsObserver) {
      commentsObserver.disconnect();
    }

    // Scan any comments that may already be present in the container
    scanForComments(container);

    commentsObserver = new MutationObserver((mutations) => {
      for (let i = 0; i < mutations.length; i++) {
        const addedNodes = mutations[i].addedNodes;
        for (let j = 0; j < addedNodes.length; j++) {
          scanForComments(addedNodes[j]);
        }
      }
    });

    // Observe child additions and subtree insertions as user scrolls
    commentsObserver.observe(container, {
      childList: true,
      subtree: true
    });
  }

  /**
   * Initializes comment tracking by locating the YouTube comments container.
   * Why: On YouTube, the comments container (#comments) is often lazy-rendered
   * only when the user starts scrolling down. We poll periodically until the container
   * exists, then attach the observer. No auto-scrolling is performed.
   */
  function initCommentsObserver() {
    resetState();

    const findContainer = () => {
      // Targets standard YouTube desktop comments container
      const container = document.querySelector('ytd-comments#comments, #comments');
      if (container) {
        if (containerWatcher) {
          clearInterval(containerWatcher);
          containerWatcher = null;
        }
        attachObserverToComments(container);
        return true;
      }
      return false;
    };

    // If container already in DOM, attach immediately
    if (!findContainer()) {
      // Otherwise watch periodically until the user scrolls and YouTube mounts it
      containerWatcher = setInterval(findContainer, 1000);
    }
  }

  /**
   * Builds on-demand short snippets for the popup.
   * Why: Comments text is NOT stored in memory. We inspect the live DOM nodes
   * mapped in commentMap, extract a short snippet (up to 80 chars), and cap
   * at 5 snippets per category. This ensures O(1) persistent memory footprint.
   *
   * @returns {Object<string, string[]>}
   */
  function getSnippets() {
    const snippets = {
      Questions: [],
      Suggestions: [],
      Feedback: [],
      Praise: [],
      Spam: [],
      Other: []
    };

    for (const [node, category] of commentMap.entries()) {
      const list = snippets[category];
      if (list && list.length < MAX_SNIPPETS_PER_CATEGORY) {
        // Only inspect if node is still attached to the DOM
        if (node.isConnected) {
          const textEl = node.querySelector('#content-text');
          if (textEl) {
            const raw = textEl.textContent.trim().replace(/\s+/g, ' ');
            if (raw) {
              const snippet = raw.length > MAX_SNIPPET_LENGTH
                ? raw.slice(0, MAX_SNIPPET_LENGTH) + '…'
                : raw;
              list.push(snippet);
            }
          }
        }
      }
    }

    return snippets;
  }

  /**
   * MESSAGE LISTENER: Responds to requests from popup.js
   * Sends current counts and live snippet samples on demand.
   */
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message && message.type === 'GET_CATEGORIZED_COMMENTS') {
      sendResponse({
        success: true,
        counts: { ...categoryCounts },
        total: totalComments,
        snippets: getSnippets(),
        hasCommentsContainer: Boolean(document.querySelector('ytd-comments#comments, #comments'))
      });
    }
    return true; // Keeps channel open for response
  });

  /**
   * Listen for YouTube's client-side SPA navigation events.
   * Why: YouTube does not reload the page when navigating between videos.
   * The 'yt-navigate-finish' event indicates the user arrived at a new video.
   */
  window.addEventListener('yt-navigate-finish', () => {
    // Only re-initialize on watch pages
    if (window.location.pathname.startsWith('/watch')) {
      initCommentsObserver();
    } else {
      resetState();
    }
  });

  // Initial startup if script runs on an active watch page
  if (window.location.pathname.startsWith('/watch')) {
    initCommentsObserver();
  }
})();
