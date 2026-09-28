/**
 * classifier.js - Pure keyword-based comment classifier for YouTube comments.
 *
 * DESIGN RATIONALE:
 * - O(1) auxiliary space: Keyword sets and phrase lists are allocated ONCE at module load.
 *   Evaluating comments does not allocate persistent structures or retain comment text.
 * - Deterministic, zero-dependency: Runs directly in browser environments without ML
 *   models, WASM weights, external APIs, or build steps.
 * - Priority-based matching: Some categories take strict precedence (e.g. Spam before Praise),
 *   because spam comments frequently mimic praise ("Love this video! Check out my telegram...").
 */

(function (root) {
  'use strict';

  // Category constants matching the project specifications.
  const CATEGORIES = {
    SPAM: 'Spam',
    QUESTIONS: 'Questions',
    SUGGESTIONS: 'Suggestions',
    FEEDBACK: 'Feedback',
    PRAISE: 'Praise',
    OTHER: 'Other' // Fallback for comments that do not match specific keyword sets
  };

  /**
   * SPAM_PHRASES & SPAM_KEYWORDS
   * Why: Spam is tested FIRST. Spam bots routinely start comments with flattering
   * remarks ("Great video bro!"), so checking praise first would cause false positives.
   * Multi-word phrases are checked against raw lowercase text, while single words
   * are matched against a tokenized Set for O(1) lookup.
   */
  const SPAM_PHRASES = [
    'check out my',
    'check my channel',
    'subscribe to my',
    'subscribe to me',
    'sub to my',
    'sub4sub',
    'free crypto',
    'free money',
    'free gift',
    'giveaway in bio',
    't.me/',
    'telegram:',
    'whatsapp me',
    'text me on whatsapp',
    'reach out on whatsapp',
    'dm me on',
    'message me on ig',
    'invest with',
    'trading platform',
    'passive income',
    'financial freedom',
    'earn $',
    'make $',
    'made $',
    'cashapp',
    'bit.ly',
    'tinyurl',
    'click the link',
    'link in bio',
    'link in description'
  ];

  const SPAM_WORDS = new Set([
    'telegram',
    'whatsapp',
    'crypto',
    'bitcoin',
    'btc',
    'forex',
    'giveaway',
    'sub4sub',
    'clck.ru'
  ]);

  /**
   * QUESTION_PHRASES & QUESTION_WORDS
   * Why: Questions are classified second. The presence of '?' is a near-universal
   * question indicator in informal internet comments. We also look for interrogative
   * starters ("can you", "how do", "why did") in case question marks were omitted.
   */
  const QUESTION_PHRASES = [
    'can you',
    'could you',
    'would you',
    'how to',
    'how do',
    'how did',
    'how does',
    'how can',
    'why is',
    'why does',
    'why did',
    'what is',
    'what are',
    'what does',
    'what did',
    'where is',
    'where did',
    'when will',
    'is there',
    'are there',
    'does anyone',
    'anyone know',
    'any idea',
    'any tips',
    'what if'
  ];

  const QUESTION_STARTER_WORDS = new Set([
    'how',
    'why',
    'what',
    'when',
    'where',
    'who',
    'which',
    'whose',
    'whom'
  ]);

  /**
   * SUGGESTION_PHRASES & SUGGESTION_WORDS
   * Why: Suggestions contain prescriptive advice, future topic ideas, or polite feature
   * requests ("You should make...", "Next video please do...", "Consider trying...").
   */
  const SUGGESTION_PHRASES = [
    'you should',
    'you could',
    'you need to',
    'how about',
    'what about',
    'next video',
    'next time',
    'please make',
    'please do',
    'can you do',
    'could you do',
    'would love to see',
    'would love if',
    'i suggest',
    'my suggestion',
    'make a video',
    'do a video',
    'try to',
    'try using',
    'consider',
    'it would be cool',
    'it would be great',
    'maybe add',
    'feature request'
  ];

  const SUGGESTION_WORDS = new Set([
    'suggest',
    'suggestion',
    'suggestions',
    'recommend',
    'recommendation',
    'recommendations',
    'propose',
    'proposal'
  ]);

  /**
   * FEEDBACK_PHRASES & FEEDBACK_WORDS
   * Why: Constructive critique often mentions technical aspects (audio, microphone, volume,
   * camera, pacing, lighting) or specific timestamps marking corrections or typos.
   */
  const FEEDBACK_PHRASES = [
    'audio quality',
    'sound quality',
    'video quality',
    'too loud',
    'too quiet',
    'too fast',
    'too slow',
    'hard to hear',
    'hard to follow',
    'hard to understand',
    'volume is',
    'mic is',
    'audio is',
    'background music',
    'constructive criticism',
    'constructive feedback',
    'mistake at',
    'typo at',
    'error at',
    'wrong timestamp'
  ];

  const FEEDBACK_WORDS = new Set([
    'feedback',
    'critique',
    'criticism',
    'audio',
    'mic',
    'microphone',
    'volume',
    'pacing',
    'confusing',
    'lighting',
    'glitch',
    'echo',
    'typo',
    'mistake',
    'correction',
    'timestamp',
    'timestamps'
  ]);

  /**
   * PRAISE_PHRASES & PRAISE_WORDS
   * Why: Praise comments express appreciation, admiration, and compliments.
   * Multi-word phrases like "great video" capture standard positive sentiment,
   * while the word set captures high-sentiment adjectives ("awesome", "masterpiece").
   */
  const PRAISE_PHRASES = [
    'great video',
    'good video',
    'amazing video',
    'awesome video',
    'love this',
    'loved this',
    'love your',
    'loved your',
    'thank you',
    'thanks for',
    'thx for',
    'well done',
    'good job',
    'great job',
    'keep it up',
    'keep up the',
    'best video',
    'best channel',
    'best explanation'
  ];

  const PRAISE_WORDS = new Set([
    'awesome',
    'amazing',
    'great',
    'excellent',
    'incredible',
    'fantastic',
    'superb',
    'brilliant',
    'masterpiece',
    'goat',
    'underrated',
    'legend',
    'legendary',
    'fire',
    'helpful',
    'inspiring',
    'congrats',
    'congratulations',
    'wholesome',
    'perfection'
  ]);

  /**
   * Helper: Checks whether any phrase in a small fixed list is present in the text.
   * Why: Substring matching handles spaces and multi-word idioms without regex overhead.
   * @param {string} lowerText - Pre-lowercased comment text.
   * @param {string[]} phrases - Array of phrase strings to check.
   * @returns {boolean}
   */
  function containsAnyPhrase(lowerText, phrases) {
    for (let i = 0; i < phrases.length; i++) {
      if (lowerText.includes(phrases[i])) {
        return true;
      }
    }
    return false;
  }

  /**
   * Helper: Checks whether any token in the word Set exists in the target keyword Set.
   * Why: Set.has() is O(1). Checking tokens against fixed sets takes O(tokens) time,
   * scaling only with the length of a single comment, not with the total comment history.
   * @param {Set<string>} tokenSet - Words present in the current comment.
   * @param {Set<string>} keywordSet - Fixed category keywords.
   * @returns {boolean}
   */
  function hasWordIntersection(tokenSet, keywordSet) {
    for (const token of tokenSet) {
      if (keywordSet.has(token)) {
        return true;
      }
    }
    return false;
  }

  /**
   * classify(text) -> categoryName
   *
   * Pure classification function.
   * Input: Raw string extracted from a YouTube comment.
   * Output: Exactly one category string:
   *   'Spam' | 'Questions' | 'Suggestions' | 'Feedback' | 'Praise' | 'Other'
   *
   * Invariant: Does NOT mutate input or retain any comment data in memory.
   * Memory usage: O(1) persistent state; temporary token Set is freed on exit.
   */
  function classify(text) {
    if (!text || typeof text !== 'string') {
      return CATEGORIES.OTHER;
    }

    const trimmed = text.trim();
    if (!trimmed) {
      return CATEGORIES.OTHER;
    }

    const lower = trimmed.toLowerCase();

    // 1. Spam check: Highest priority to eliminate deceptive spam disguised as praise
    if (containsAnyPhrase(lower, SPAM_PHRASES)) {
      return CATEGORIES.SPAM;
    }

    // Tokenize into lowercase alphanumeric words for O(1) set lookups
    const tokens = lower.match(/[a-z0-9']+/g) || [];
    const tokenSet = new Set(tokens);

    if (hasWordIntersection(tokenSet, SPAM_WORDS)) {
      return CATEGORIES.SPAM;
    }

    // 2. Questions check: Punctuation is the strongest signal
    if (lower.includes('?')) {
      return CATEGORIES.QUESTIONS;
    }
    if (containsAnyPhrase(lower, QUESTION_PHRASES)) {
      return CATEGORIES.QUESTIONS;
    }
    // Check if the comment starts with an interrogative word (e.g., "How you did this")
    if (tokens.length > 0 && QUESTION_STARTER_WORDS.has(tokens[0])) {
      return CATEGORIES.QUESTIONS;
    }

    // 3. Suggestions check: Prescriptive advice or future requests
    if (containsAnyPhrase(lower, SUGGESTION_PHRASES) || hasWordIntersection(tokenSet, SUGGESTION_WORDS)) {
      return CATEGORIES.SUGGESTIONS;
    }

    // 4. Feedback check: Technical critique, pacing, mistakes, or audio/video commentary
    if (containsAnyPhrase(lower, FEEDBACK_PHRASES) || hasWordIntersection(tokenSet, FEEDBACK_WORDS)) {
      return CATEGORIES.FEEDBACK;
    }

    // Check for timestamp patterns (e.g., "at 03:45", "12:30", "at 1:20") which often indicate feedback
    if (/\b\d{1,2}:\d{2}\b/.test(lower) && (tokenSet.has('at') || tokenSet.has('part') || tokenSet.has('scene'))) {
      return CATEGORIES.FEEDBACK;
    }

    // 5. Praise check: Compliments and positive affirmations
    if (containsAnyPhrase(lower, PRAISE_PHRASES) || hasWordIntersection(tokenSet, PRAISE_WORDS)) {
      return CATEGORIES.PRAISE;
    }

    // 6. Default fallback for unclassified visible comments
    return CATEGORIES.OTHER;
  }

  // Export to global scope in browser, or module.exports in Node.js test environment
  root.classify = classify;
  root.CATEGORIES = CATEGORIES;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { classify, CATEGORIES };
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
