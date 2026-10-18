# IELTS Copilot

<p align="center">
  <img src="icons/icon128.png" width="96" alt="IELTS Copilot icon" />
</p>

<p align="center">
  <a href="https://github.com/QIAFAN-FAN/ielts-copilot/releases"><img src="https://img.shields.io/github/v/release/QIAFAN-FAN/ielts-copilot?label=version&color=blue" alt="version" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-green" alt="license" /></a>
  <img src="https://img.shields.io/badge/Chrome-116%2B-yellow" alt="Chrome" />
  <img src="https://img.shields.io/badge/Manifest-V3-orange" alt="Manifest V3" />
  <img src="https://img.shields.io/badge/build-none-success" alt="no build step" />
</p>

<p align="center">
  <b>English</b> · <a href="README.md">简体中文</a>
</p>

---

A Chrome side-panel assistant for IELTS preparation: word lookup, reading question analysis, listening question analysis, writing ideas and essay marking.

It ships with a built-in **2,400-word offline dictionary**, a **glossary**, and **vocabulary auto-learning** — so the more you use it, the less API cost you pay.

> **Interface languages**: 简体中文 / English / 日本語 / 한국어 / Tiếng Việt — switchable in Settings, applies instantly.

## What it does

| Feature | What you get |
| --- | --- |
| **Word lookup** | Select any text on a page → a bubble shows the translation, one line about the sentence structure, and up to 4 high-frequency IELTS words. 📋 copies the result (Chinese / English / both — configurable) |
| **Reading** | Click "Grab page" → it splits the page into passage and questions automatically, then gives an answer table, per-question analysis (with the locating sentence and synonym mapping), a synonym list, and the reasoning steps |
| **Listening** | Grab the questions → it identifies the source (which Cambridge book / section), gives reference answers with confidence levels, and explains the listening traps |
| **Writing** | Two separate prompts: one for ideas + structure + a full model essay; one that marks your essay against the four IELTS criteria with a estimated band score |
| **Explain** | Select text → "Explain" for a grammar and test-point breakdown |

Task 1 charts can be added as images: upload, capture the screen, grab images from the page, drag-and-drop, or paste with `Ctrl+V`.

## Install (about 2 minutes)

This extension is **not on the Chrome Web Store** — load it in developer mode:

1. Download this repo (`Code` → `Download ZIP`, or `git clone`) and **extract** it
2. Go to `chrome://extensions/`
3. Turn on **Developer mode** (top right)
4. Click **Load unpacked** and pick the folder that **directly contains `manifest.json`**
5. Click the extension icon in the toolbar to open the side panel

### Add your API key (once)

1. Sign up at [platform.deepseek.com](https://platform.deepseek.com) and create a key under "API Keys"
2. Right-click the extension icon → **Options**
3. Paste the key, click **Test connection**, then **Save settings**

## How it saves your money

Saving tokens here is not about calling the API less — it is about **not calling it when you don't need to**.

**1. Two-stage translation.** The bubble first shows a result computed purely locally (instant), and only calls the AI if that result isn't good enough. You never wait several seconds staring at "translating…".

**2. 2,400-word offline dictionary.** Single words and short phrases **never** call the API.

**3. Glossary.** Some words mean different things in different sentences (`bank` = river bank or financial bank). You tell the model which meaning to use, and it must follow. Ships with unambiguous technical terms and fixed collocations only — deliberately **no "rare meaning" entries**, because the glossary is an unconditional hard constraint and forcing a rare meaning would skew normal translations.

**4. Vocabulary auto-learning.** AI translation returns word-level definitions for the sentence. When the same word gets the **same definition 3 times**, it is added to the offline dictionary — from then on, sentences containing it cost nothing. Four safeguards prevent learning wrong meanings (words already in the dictionary are never learned; a word with two different definitions is never auto-added; learned words never override built-in ones; everything is visible and deletable in Settings).

**5. Three cache layers** — memory, `chrome.storage`, per-session.

## Privacy

- Your API key lives **only** in your own browser's `chrome.storage.local`
- Requests go **only** to the endpoint you configure (default `api.deepseek.com`) — no proxy server, no analytics
- Selected text is sent to DeepSeek as part of the request (unavoidable when calling the API); nothing else is collected
- Caches, drafts, vocabulary and glossary stay on your machine; uninstalling clears everything

## Known limitations

- Not on the Chrome Web Store; you must reload manually after updates
- DeepSeek only — other models are untested
- The bubble can be clipped on pages that render content inside an iframe
- Some SPA sites need a page refresh if they re-render the whole body
- Page grabbing relies on layout heuristics; use "Use selection" when it misses something
- **No real-time captions**: DeepSeek has no speech-to-text API, so captions would require a separate ASR service or a local model

## License

**GNU AGPL-3.0** — see [LICENSE](LICENSE).

In plain words:

- ✅ **Use it freely** — for yourself, for classmates, on any machine
- ✅ **Modify it however you like**
- ❌ **But you may not rebrand it as your own work** — if you distribute or publish a modified version, it must also be open-sourced under AGPL-3.0 **with the original author's attribution and a link back to this repository**
- ❌ **No closed-source commercial use**

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). For security issues, please use the private channel described in [SECURITY.md](SECURITY.md) instead of a public issue.

## Author

**QIAFAN-FAN**
