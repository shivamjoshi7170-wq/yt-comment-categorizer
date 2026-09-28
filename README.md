# YT Comment Categorizer

A lightweight Chrome Manifest V3 extension that classifies visible YouTube comments into:
- ❓ **Questions**
- 💡 **Suggestions**
- 📝 **Feedback**
- ⭐ **Praise**
- 🚫 **Spam**
- 💬 **Other**

Zero AI/ML dependencies, no external APIs, no accounts, no background databases, and zero build steps.

---

## How It Works

1. **Lazy-Load Friendly**: YouTube streams comments dynamically as you scroll down. The content script uses a non-intrusive `MutationObserver` attached to `#comments` / `ytd-comments`. It **never** force-scrolls or auto-fetches data.
2. **Minimal Memory Footprint (\(O(1)\) Beyond 1 Label Per Comment)**:
   - Full comment text is **never** duplicated or stored in JavaScript memory.
   - Comments state is stored as a `Map<DOMElement, categoryLabel>` plus a static count object.
   - Snippet previews are extracted directly from the live DOM on-demand when the popup opens, capped at 5 short snippets per category.
3. **Pure Keyword Classifier**:
   - `classifier.js` exposes a pure function `classify(text)` with pre-allocated keyword sets.
   - Evaluates high-risk categories like **Spam** first to prevent deceptive bots from polluting **Praise** or **Questions**.

---

## How to Load in Google Chrome

1. Open Google Chrome and navigate to `chrome://extensions/`.
2. Enable **Developer mode** using the toggle switch in the top-right corner.
3. Click **Load unpacked** in the top-left toolbar.
4. Select this directory:
   ```
   c:\Users\shiva\Documents\yt-comment-categorizer
   ```
5. Navigate to any YouTube video (e.g. `https://www.youtube.com/watch?v=...`).
6. Scroll down so YouTube loads comments.
7. Click the **YT Comment Categorizer** icon in your Chrome toolbar to view categorized counts and expand snippets.

---

## Project Structure

```
yt-comment-categorizer/
├── manifest.json       # Chrome MV3 manifest with minimal activeTab permission
├── classifier.js       # Pure function classify(text) with O(1) keyword sets
├── content-script.js   # MutationObserver for comment nodes, O(1) memory state, messaging
├── popup.html          # Clean popup window markup
├── popup.css           # YouTube-themed dark styling with accordion lists
├── popup.js            # Message-passing controller and DOM renderer
├── icons/              # Extension icons (16px, 48px, 128px)
└── README.md           # Documentation
```
