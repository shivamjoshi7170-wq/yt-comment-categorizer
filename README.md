# YT Comment Categorizer (Injected On-Page Panel)

A lightweight Chrome Manifest V3 extension that embeds an interactive categorization panel **directly into the YouTube watch page DOM**, positioned next to/above the comments section.

Classifies visible comments in real-time into:
- ❓ **Questions**
- 💡 **Suggestions**
- 📝 **Feedback**
- ⭐ **Praise**
- 🚫 **Spam**
- 💬 **Other**

Zero external AI/ML APIs, no database, no popup required, and zero build step.

---

## Core Architecture

### 1. Injected On-Page Panel (No Popups)
Unlike standard popup extensions that close whenever you click away, this extension mounts a persistent, responsive panel directly into YouTube's DOM inside `ytd-comments#comments` (right above the comment threads).
- Follows YouTube's native theme (dark and light mode).
- Uses YouTube's natural layout flow so it never overlaps the video player, controls, or recommendations sidebar.
- Responsive across wide desktops, theater mode, and mobile/narrow viewports.

### 2. YouTube SPA (Single Page Application) Navigation Handling
YouTube does not reload the page when you click to watch another video — it swaps player and page content via JavaScript. Standard `DOMContentLoaded` or `load` events do **not** fire on subsequent video clicks.
- The extension listens to YouTube's custom DOM event: **`yt-navigate-finish`**.
- When `yt-navigate-finish` fires:
  1. Old observers and timers are disconnected.
  2. The `commentMap` and category counts are reset to zero.
  3. The previous video's panel is cleanly removed from the DOM.
  4. The scanning and rendering functions are re-run fresh for the new video without forcing a page reload.

### 3. Non-Intrusive MutationObserver
YouTube streams comments dynamically as you scroll down. The content script attaches a targeted `MutationObserver` directly to the comments container:
- **Never force-scrolls or auto-loads** comments.
- Respects YouTube's asynchronous Web Component hydration (handles cases where `#content-text` renders moments after the thread shell).
- Debounces panel re-renders with `requestAnimationFrame` to ensure smooth 60fps scrolling.

### 4. Memory Footprint: \(O(1)\) Beyond 1 Label Per Comment
- Full comment text is **never** duplicated or retained in JavaScript memory.
- State is held as a `Map<Element, string>` (mapping the live DOM node to its category string) plus a fixed 6-key numeric counts object.
- Snippet previews are extracted directly from the live DOM node on demand when a user expands a category, capped to 5 short strings (max 85 chars).

---

## File Structure

```
yt-comment-categorizer/
├── manifest.json       # Chrome MV3 manifest (CSS + Content Script, no popup)
├── classifier.js       # Pure function classify(text) -> categoryName
├── content-script.js   # Panel injection, MutationObserver, SPA lifecycle, O(1) state
├── panel.css           # Native YouTube dark/light theme integration and responsive grid
├── icons/              # Extension icons (16px, 48px, 128px)
└── README.md           # Documentation
```

---

## How to Install and Test

1. Open Google Chrome and go to `chrome://extensions/`.
2. Turn on **Developer mode** (top-right toggle).
3. Click **Load unpacked** (top-left) and select this directory:
   ```
   c:\Users\shiva\Documents\yt-comment-categorizer
   ```
4. Open any YouTube video (e.g. `https://www.youtube.com/watch?v=...`).
5. Scroll down to the comments section:
   - The **YT Comment Categorizer** panel appears right above the comment threads.
   - As you scroll down to load more comments, counts update in real-time.
   - Click any category card to preview short live snippets.
   - Click any other video to verify SPA navigation reset.
