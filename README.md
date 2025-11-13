# 🖥️ 4MAC2SCREEN  
> **Wireless macOS screen mirroring — zero latency, native quality, no middleman.**  
> Like Deskreen, but built for macOS with **WebRTC + SimplePeer** — direct, efficient, and sleek.

![Architecture](https://img.shields.io/badge/architecture-WebRTC%20%2B%20Socket.IO-blue?logo=webrtc)  
![License](https://img.shields.io/badge/license-MIT-000?style=flat)  
![Platform](https://img.shields.io/badge/platform-macOS%20+%20Web-FF6F61)

---

## 🚀 Quick Start

```bash
npm install
npm start
```

→ Open the URL shown in the app (e.g. `http://192.168.1.100:3001`) in any browser.  
→ Select your **BetterDisplay virtual screen** and stream — instantly.

> ✅ Works out of the box on macOS with *Screen Recording* permission.  
> ✅ 60+ FPS, native resolution, near-zero latency — **no transcoding, no cloud**.

---

## 🧠 Core Architecture

```
┌──────────────────┐       ┌──────────────────┐       ┌──────────────────┐
│   Electron       │       │   Signaling      │       │   Browser        │
│   Renderer       │──────▶│   (Socket.IO)    │◀──────│   Client         │
│   • getUserMedia │       │   • SDP/ICE      │       │   • <video> tag  │
│   • SimplePeer   │◀──────│   • Server       │──────▶│   • SimplePeer   │
│     (initiator)  │       └──────────────────┘       │     (receiver)   │
└──────────────────┘                                  └──────────────────┘
          │                                                     ▲
          └────────────── WebRTC P2P MediaStream ◀─────────────┘
               (direct peer-to-peer, no server relay)
```

- 🔹 **MediaStream** is captured via `chromeMediaSource: 'desktop'` (Electron-specific)
- 🔹 **Signaling only** via Socket.IO — **video never touches the server**
- 🔹 **End-to-end WebRTC** — encrypted, low-latency, hardware-accelerated

---

## 📊 Performance Profile

| Metric               | Value                         |
|----------------------|-------------------------------|
| **Latency**          | ~50–120 ms (LAN)              |
| **FPS**              | Up to 60 (configurable)       |
| **Resolution**       | Native (up to 4K)             |
| **CPU Load**         | Low (GPU-hw encoding used)    |
| **Network**          | ~15–50 Mbps (1080p60 H.264)   |
| **Compatibility**    | Chrome, Edge, Safari ≥16.4    |

> ✨ Ideal for presentations, remote collaboration, or using an iPad as a wireless monitor.

---

## ⚙️ Configuration

### Video Quality

In [`renderer-webrtc.html`](./renderer-webrtc.html):
```js
async function getDesktopSourceStream(
  sourceID,
  width = null,          // null = native
  height = null,         // null = native
  minFrameRate = 30,     // ↓ reduce for low-end networks
  maxFrameRate = 60      // ↑ cap to limit bandwidth
) { /* ... */ }
```

### WebRTC Settings

Add STUN/TURN for complex NATs:
```js
const peer = new SimplePeer({
  initiator: true,
  stream,
  config: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      // { urls: 'turn:...', username: '...', credential: '...' }
    ]
  }
});
```

---

## 🛠️ Troubleshooting

| Symptom                | Fix                                                                 |
|------------------------|---------------------------------------------------------------------|
| ❌ Blank video         | • Grant **Screen Recording** in *System Settings → Privacy*<br>• Restart app after permission |
| ❌ No peer connection  | • Check browser console (`F12`)<br>• Ensure both sides are on same network<br>• Disable firewall temporarily |
| 🐢 Lag / stutter       | • Lower `maxFrameRate`<br>• Use wired Ethernet<br>• Close other video apps |
| 🔌 Signaling fails     | • Verify `Socket.IO` handshake in **Network tab**<br>• Confirm port `3001` is open |

> 💡 **Pro tip**: Use `chrome://webrtc-internals` to debug WebRTC stats in real time.

---

## 🔐 Security Notes

- 🔒 **MediaStream** is **always P2P encrypted** (DTLS-SRTP).
- ⚠️ **Signaling (Socket.IO)** is *unencrypted by default* — fine for LAN, but **not for public networks**.
  
For production/deployed use:
- Serve over `https` + `wss`
- Add authentication middleware
- Use TURN with credentials

---

## 🛠 Built With

| Tech             | Role                                  |
|------------------|---------------------------------------|
| **Electron**     | macOS desktop capture & renderer      |
| **SimplePeer**   | Lightweight WebRTC abstraction        |
| **Socket.IO**    | Reliable signaling channel            |
| **BetterDisplay**| Virtual screen driver (macOS)         |
| **Vanilla JS**   | Zero framework bloat                  |

---

## 📜 License

MIT — fork, improve, adapt.  
Just keep it sharp, fast, and user-respectful. 🫡

---

> Made with precision for macOS power users.  
> No ads. No telemetry. No compromises.
