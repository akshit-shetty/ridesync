# 🏍️ RideSync — Group Ride Tracker

> Real-time motorcycle group tracking app — see your squad on the map, live.

## Features
- 📍 **Live GPS tracking** — your location updates every 3 seconds
- 🗺️ **Live map** — see all riders with colored markers and route trails
- 🔗 **Instant join** — share a link, friends tap to join, no sign-up
- 📊 **Ride stats** — speed, distance, and duration in real-time
- 📵 **PWA** — install on your home screen like a native app
- 💬 **Share via WhatsApp** — one tap to invite your squad

---

## ⚙️ Setup (Required — Firebase)

The app needs Firebase to sync locations in real-time. It's **free** for small groups.

### Step 1: Create Firebase Project
1. Go to [https://console.firebase.google.com/](https://console.firebase.google.com/)
2. Click **"Add Project"** → Name it `RideSync` → Click through
3. On the dashboard, click the **Web icon** (`</>`)
4. Name it `RideSync Web` → Click **"Register app"**
5. **Copy the `firebaseConfig` object** shown on screen

### Step 2: Add Your Config
Open `js/firebase-config.js` and replace the placeholder values:

```javascript
export const firebaseConfig = {
  apiKey: "YOUR_ACTUAL_API_KEY",
  authDomain: "your-project.firebaseapp.com",
  projectId: "your-project-id",
  storageBucket: "your-project.appspot.com",
  messagingSenderId: "123456789",
  appId: "1:123456789:web:abc123"
};
```

### Step 3: Enable Firestore
1. In Firebase Console → **Firestore Database** → **Create database**
2. Choose **"Start in test mode"** (for development)
3. Select your nearest region → **Enable**

### Step 4: Run Locally
You need a local server (HTTPS required for GPS on mobile).

```bash
# Option 1: npx serve (simplest)
npx serve .

# Option 2: VS Code Live Server extension
# Right-click index.html → Open with Live Server

# Option 3: Python
python -m http.server 8080
```

Then open on your phone: `http://YOUR_COMPUTER_IP:PORT`

---

## 📱 How to Use

1. **Rider 1 (You)**: Open the app → Enter your name → Tap **"Start Ride"**
2. **Share the link**: Tap **"Invite Riders"** → Send via WhatsApp
3. **Friends**: Open the link → Enter their name → They join automatically
4. Everyone sees each other live on the dark map 🗺️

---

## 🚀 Deploy (Optional)

To make it accessible from any phone via the internet:

```bash
# Install Firebase CLI
npm install -g firebase-tools

# Login & init
firebase login
firebase init hosting

# Deploy
firebase deploy
```

---

## 📁 File Structure

```
Riding app/
├── index.html          # Landing page (Create/Join)
├── ride.html           # Live map page
├── manifest.json       # PWA config
├── service-worker.js   # Offline caching
├── css/
│   ├── style.css       # Home page styles
│   └── ride.css        # Map & HUD styles
├── js/
│   ├── firebase-config.js  # ← PUT YOUR CONFIG HERE
│   ├── home.js         # Create/join logic
│   ├── ride.js         # GPS + map tracking
│   └── utils.js        # Shared utilities
└── assets/
    ├── icon-192.png
    └── icon-512.png
```

---

## ⚠️ GPS Notes
- GPS works best in **Chrome on Android** or **Safari on iPhone**
- The page must be served over **HTTPS** (or localhost) for GPS to work
- Location is only shared with riders in the same ride session
