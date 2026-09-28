/**
 * popup.js - Controller for the YT Comment Categorizer extension popup.
 *
 * DESIGN RATIONALE:
 * - Direct Active-Tab Communication: Uses `chrome.tabs.sendMessage` to query the content
 *   script on demand. The popup maintains NO independent database or background worker.
 * - Defensive Error Handling: Gracefully informs the user if they are not on a YouTube watch
 *   page, if the tab was opened before extension installation, or if comments haven't
 *   been scrolled to yet.
 * - Accordion UI: Displays counts prominently while allowing users to expand categories
 *   to view short snippet previews without cluttering the compact popup window.
 */

document.addEventListener('DOMContentLoaded', () => {
  'use strict';

  // DOM Elements
  const statusBanner = document.getElementById('statusBanner');
  const totalCountEl = document.getElementById('totalCount');
  const categoriesContainer = document.getElementById('categoriesContainer');
  const refreshBtn = document.getElementById('refreshBtn');

  // Metadata for rendering each category in a consistent, user-friendly order
  const CATEGORY_META = [
    { key: 'Questions', label: 'Questions', icon: '❓', badgeClass: 'cat-questions' },
    { key: 'Suggestions', label: 'Suggestions', icon: '💡', badgeClass: 'cat-suggestions' },
    { key: 'Feedback', label: 'Feedback', icon: '📝', badgeClass: 'cat-feedback' },
    { key: 'Praise', label: 'Praise', icon: '⭐', badgeClass: 'cat-praise' },
    { key: 'Spam', label: 'Spam', icon: '🚫', badgeClass: 'cat-spam' },
    { key: 'Other', label: 'Other', icon: '💬', badgeClass: 'cat-other' }
  ];

  /**
   * Displays an informational or error status message.
   * @param {string} message
   * @param {'info' | 'error' | 'warning'} type
   */
  function showStatus(message, type = 'warning') {
    statusBanner.textContent = message;
    statusBanner.className = `status-banner ${type}`;
    statusBanner.classList.remove('hidden');
  }

  function hideStatus() {
    statusBanner.classList.add('hidden');
  }

  /**
   * Queries the content script on the current active YouTube tab.
   * Why: Uses activeTab permissions without needing persistent background scripts.
   */
  async function fetchCommentStats() {
    hideStatus();

    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

      if (!tab) {
        showStatus('Could not identify active browser tab.', 'error');
        return;
      }

      // Check if URL is a YouTube watch page
      if (!tab.url || !tab.url.includes('youtube.com/watch')) {
        showStatus('Please navigate to a YouTube video watch page to categorize comments.', 'info');
        renderCategories({}, {}, 0);
        return;
      }

      // Request live categorized state from content-script.js
      chrome.tabs.sendMessage(
        tab.id,
        { type: 'GET_CATEGORIZED_COMMENTS' },
        (response) => {
          // If content script was not injected (e.g. page opened before extension loaded)
          if (chrome.runtime.lastError) {
            showStatus(
              'Please refresh the YouTube page to activate the categorizer.',
              'warning'
            );
            renderCategories({}, {}, 0);
            return;
          }

          if (!response || !response.success) {
            showStatus('Unable to retrieve comments data.', 'error');
            return;
          }

          const { counts, total, snippets, hasCommentsContainer } = response;
          totalCountEl.textContent = total;

          // If no comments detected yet, give a helpful prompt
          if (total === 0) {
            if (hasCommentsContainer) {
              showStatus('Comments section found, but no comments loaded yet. Scroll down on YouTube to view comments.', 'info');
            } else {
              showStatus('Scroll down the YouTube page to load the comments section.', 'info');
            }
          }

          renderCategories(counts, snippets, total);
        }
      );
    } catch (err) {
      showStatus('An unexpected error occurred: ' + err.message, 'error');
    }
  }

  /**
   * Renders the category cards, badges, and expandable snippet lists.
   *
   * @param {Object<string, number>} counts - Category tallies
   * @param {Object<string, string[]>} snippets - Short live text snippets
   * @param {number} total - Total classified comments
   */
  function renderCategories(counts = {}, snippets = {}, total = 0) {
    categoriesContainer.innerHTML = '';

    CATEGORY_META.forEach((meta) => {
      const count = counts[meta.key] || 0;
      const snippetList = snippets[meta.key] || [];

      // Create category card container
      const card = document.createElement('div');
      card.className = 'category-card';

      // Auto-expand categories that have comments if total comment count is small
      if (count > 0 && total <= 10) {
        card.classList.add('expanded');
      }

      // Header button (Accordion toggle)
      const headerBtn = document.createElement('button');
      headerBtn.className = 'category-header';
      headerBtn.setAttribute('aria-expanded', card.classList.contains('expanded'));
      headerBtn.innerHTML = `
        <div class="category-info">
          <span>${meta.icon}</span>
          <span class="category-name">${meta.label}</span>
          <span class="category-count ${meta.badgeClass}">${count}</span>
        </div>
        <span class="toggle-arrow">▼</span>
      `;

      // Snippets list container
      const snippetsContainer = document.createElement('div');
      snippetsContainer.className = 'snippets-container';

      if (snippetList.length === 0) {
        const emptyMsg = document.createElement('div');
        emptyMsg.className = 'snippet-empty';
        emptyMsg.textContent = count === 0
          ? 'No comments in this category yet.'
          : 'Scroll to comments to preview snippets.';
        snippetsContainer.appendChild(emptyMsg);
      } else {
        snippetList.forEach((snippet) => {
          const item = document.createElement('div');
          item.className = 'snippet-item';
          item.textContent = `"${snippet}"`;
          snippetsContainer.appendChild(item);
        });
      }

      // Toggle accordion on header click
      headerBtn.addEventListener('click', () => {
        const isExpanded = card.classList.toggle('expanded');
        headerBtn.setAttribute('aria-expanded', isExpanded);
      });

      card.appendChild(headerBtn);
      card.appendChild(snippetsContainer);
      categoriesContainer.appendChild(card);
    });
  }

  // Refresh button event listener
  refreshBtn.addEventListener('click', () => {
    fetchCommentStats();
  });

  // Initial fetch on popup open
  fetchCommentStats();
});
