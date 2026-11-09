# Stark OS / J.A.R.V.I.S.

Tony Stark–style HUD + voice assistant for Windows 11. The brain is **Cursor Agent SDK** (local), with allowlisted PC tools and confirmations for destructive actions.

## Quick start

```powershell
cd D:\Projects\CursorProjects\stark-os
npm install
npm run login          # browser login → stores SDK key (or put CURSOR_API_KEY in .env)
npm run apply-visual   # dark mode + Windows Terminal Stark theme (reversible)
npm start              # JARVIS HUD
```

### Hotkeys
| Shortcut | Action |
|---|---|
| `Ctrl+Shift+J` | Push-to-talk (RU speech) |
| `Ctrl+Shift+H` | Toggle HUD |
| `Ctrl+Shift+Y` / `N` | Confirm / cancel gated tools |

### Restore visuals
```powershell
npm run restore-visual
```

### Autostart (optional, after you like the MVP)
```powershell
npm run enable-startup
npm run disable-startup
```

### Voice (AI TTS)
Default: **Microsoft Edge neural** — `en-GB-RyanNeural` (British, JARVIS-ish) / `ru-RU-DmitryNeural`. In `config/voice.json`, `lockVoice` forces one timbre for mixed RU/EN replies.

Long answers are split into chunks. If Edge drops the socket (common with VPN), older builds fell back to **robotic Windows SAPI for the whole message** — now each chunk is neural-first; SAPI is per-chunk only.

**Offline / local AI voice (Piper):**
```powershell
powershell -ExecutionPolicy Bypass -File scripts/setup-piper.ps1
```
Then set `"provider": "piper"` in `config/voice.json` and rebuild. Models: British male + Russian `ruslan`.

**Cinematic cloud clone (ElevenLabs)** — best “movie JARVIS”; set in `.env`:
```
ELEVENLABS_API_KEY=...
ELEVENLABS_VOICE_ID=...
```
and `"provider": "elevenlabs"`.

### Natural language
Ask in plain Russian/English — no fixed command phrases. Examples:
- «Джарвис, дай мне стим»
- «что с системой?»
- «открой курсор»

JARVIS uses Cursor Agent tools (`open_app`, `system_status`, …) to act.
- `проекты`

### Wallpaper Engine
Open a **Web** wallpaper and select:
`assets/wallpapers/stark-hud.html`

## Safety
- Does **not** disable Defender / UAC / Tamper Protection
- Shell tools are allowlisted (`config/apps.allowlist.json`)
- Game mode / minimize-others require HUD confirmation
- Snapshots of prior theme/startup live in `snapshots/`

## Layout
- `src/main` — Electron main, brain, TTS, tools
- `src/renderer` — cyan HUD UI
- `config/` — palette, hotkeys, JARVIS system prompt, app allowlist
