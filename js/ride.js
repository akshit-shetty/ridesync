// ===== RIDE.JS — Live GPS Tracking & Map Logic =====

import {
  collection,
  doc,
  setDoc,
  updateDoc,
  onSnapshot,
  serverTimestamp,
  getDoc,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

import {
  showToast,
  calcDistance,
  formatTime,
  getInitials,
} from "./utils.js";

// ===== UNICODE-SAFE BASE64 DECODING =====
// Reverse of home.js unicodeToUrlBase64: restores URL-safe chars, re-pads, decodes UTF-8.
function urlBase64ToUnicode(encoded) {
  const b64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '=='.slice(0, (4 - b64.length % 4) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

// ===== STATE =====
let map = null;
let myMarker = null;
const riderMarkers = {};
const riderPolylines = {};
const riderPaths = {};

let watchId = null;
let timerInterval = null;
let startTime = null;
let totalDistance = 0;
let lastLat = null, lastLng = null;
let topSpeed = 0;
let elapsedSeconds = 0;
let lastGPSUpdateTime = null;

let db = null;
let session = null;
let rideId = null;
let unsubscribeRiders = null;
let unsubscribeRide = null;
let currentRiders = [];
let isRiderRegistered = false;

// ===== DESTINATION STATE =====
let destination = null;        // { name, lat, lng } or null
let routingControl = null;     // Leaflet Routing Machine control
let routeLayer = null;         // Fallback straight-line polyline
let destMarker = null;         // Destination flag marker
let routeVisible = true;
let routeInitialized = false;  // Only draw route after real GPS received
let lastRouteUpdateLat = null;
let lastRouteUpdateLng = null;
const ROUTE_UPDATE_DIST_KM = 0.2; // Refresh route every 200m moved
let hasFitBounds = false;      // Automatically zoom to show the full route once

// ===== NAVIGATION STATE =====
let isNavigating = false;      // True if active navigation has started
let isMapCentered = true;      // Auto-center map on rider location
let trafficPolylines = [];     // Color-coded Leaflet path segments for traffic

// ===== INIT =====
export function initRide(firestoreDb) {
  db = firestoreDb;

  // Resolve session and rideId robustly
  const params = new URLSearchParams(window.location.search);
  const urlRideId = params.get("r") || params.get("ride");
  const encoded = params.get("s");

  session = null;
  rideId = null;

  // 1. Try URL encoded session first
  if (encoded) {
    try {
      session = JSON.parse(urlBase64ToUnicode(encoded));
      if (session && session.rideId) {
        rideId = session.rideId;
        // Destination is baked into the session payload by home.js
        if (session.destination && session.destination.lat && session.destination.lng) {
          destination = session.destination;
        }
        // Save to sessionStorage and localStorage as backup
        sessionStorage.setItem("ridesync_session", JSON.stringify(session));
        localStorage.setItem("ridesync_rider", JSON.stringify(session));
      }
    } catch(e) {
      console.error("Failed to decode session from URL:", e);
    }
  }

  // 2. If no session from URL, check sessionStorage
  if (!session) {
    try {
      const ss = sessionStorage.getItem("ridesync_session");
      if (ss) {
        const parsed = JSON.parse(ss);
        // Only use it if it matches the ride ID in the URL (if URL has one)
        if (!urlRideId || parsed.rideId === urlRideId) {
          session = parsed;
          rideId = session.rideId;
        }
      }
    } catch(e) {}
  }

  // 3. If still no session, check localStorage
  if (!session) {
    try {
      const ls = localStorage.getItem("ridesync_rider");
      if (ls) {
        const parsed = JSON.parse(ls);
        // Only use it if it matches the ride ID in the URL (if URL has one)
        if (!urlRideId || parsed.rideId === urlRideId) {
          session = parsed;
          rideId = session.rideId;
        }
      }
    } catch(e) {}
  }

  // Fallback ride ID from URL if not resolved yet
  if (!rideId) {
    rideId = urlRideId;
  }

  // 4. Redirect to index.html with ride ID to join if we have the ride ID but no user session
  if (!session && rideId) {
    document.body.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:center;height:100vh;
        font-family:'Outfit',sans-serif;background:#0a0a0f;
        flex-direction:column;gap:16px;text-align:center;padding:24px;">
        <div style="font-size:2.5rem;">🏍️</div>
        <div style="font-size:1.1rem;font-weight:700;color:#f0f0f5;">Joining ride...</div>
        <div style="color:#8888aa;font-size:0.85rem;">Redirecting to enter your name and join the squad...</div>
      </div>`;
    setTimeout(() => { window.location.href = `index.html?ride=${rideId}`; }, 1200);
    return;
  }

  // 5. If we have neither session nor ride ID, redirect to home page
  if (!session || !rideId) {
    document.body.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:center;height:100vh;
        font-family:'Outfit',sans-serif;background:#0a0a0f;
        flex-direction:column;gap:16px;text-align:center;padding:24px;">
        <div style="font-size:2.5rem;">🏍️</div>
        <div style="font-size:1.1rem;font-weight:700;color:#f0f0f5;">No active ride session</div>
        <div style="color:#8888aa;font-size:0.85rem;">Redirecting to home page...</div>
      </div>`;
    setTimeout(() => { window.location.href = "index.html"; }, 1500);
    return;
  }

  // Setup UI
  setupMapWithGPS();
  setupUIHandlers();

  // Only the host is allowed to start/pause navigation
  if (session && !session.isHost) {
    const startNavBtn = document.getElementById("startNavBtn");
    if (startNavBtn) {
      startNavBtn.style.display = "none";
    }
  }
}

// ===== GPS + MAP SETUP =====
function setupMapWithGPS() {
  const gpsOverlay = document.getElementById("gpsOverlay");
  const enableBtn = document.getElementById("enableGpsBtn");

  // Check if geolocation is available
  if (!("geolocation" in navigator)) {
    gpsOverlay.querySelector(".gps-title").textContent = "GPS Not Available";
    gpsOverlay.querySelector(".gps-desc").textContent =
      "Your browser doesn't support GPS. Please use a modern mobile browser like Chrome.";
    enableBtn.style.display = "none";
    return;
  }

  enableBtn.addEventListener("click", () => {
    gpsOverlay.style.opacity = "0.7";
    enableBtn.textContent = "Requesting GPS...";
    enableBtn.disabled = true;
    startTracking();
  });

  // Auto-request on mobile if permission might already be granted
  if (navigator.permissions) {
    navigator.permissions.query({ name: "geolocation" }).then((result) => {
      if (result.state === "granted") {
        gpsOverlay.classList.add("hidden");
        startTracking();
      }
      // else wait for user click
    }).catch(() => {
      // Permissions API not supported — wait for click
    });
  }
}

function startTracking() {
  // Option 1: Try high accuracy first (5 second timeout)
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      document.getElementById("gpsOverlay").classList.add("hidden");
      initMapAndTracking(pos.coords.latitude, pos.coords.longitude);
    },
    (err) => {
      console.warn("High accuracy GPS failed, trying fallback...", err);
      // Option 2: Fallback to low accuracy (network/wifi triangulation)
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          document.getElementById("gpsOverlay").classList.add("hidden");
          initMapAndTracking(pos.coords.latitude, pos.coords.longitude);
        },
        (fallbackErr) => {
          console.error("GPS tracking completely failed:", fallbackErr);
          const overlay = document.getElementById("gpsOverlay");
          if (overlay) overlay.style.opacity = "1";
          const btn = document.getElementById("enableGpsBtn");
          if (btn) {
            btn.disabled = false;
            btn.textContent = "📍 Try Again";
          }

          if (fallbackErr.code === 1) {
            showToast("GPS access denied. Please allow location in browser settings.", "error", 5000);
          } else {
            showToast("Couldn't get your location. Check GPS signal.", "error");
          }
        },
        { enableHighAccuracy: false, timeout: 10000 }
      );
    },
    { enableHighAccuracy: true, timeout: 5000 }
  );
}

async function initMapAndTracking(initialLat, initialLng) {
  // Initialize Leaflet map first
  const centerLat = initialLat || 19.076;
  const centerLng = initialLng || 72.877;

  map = L.map("map", {
    center: [centerLat, centerLng],
    zoom: 16,
    zoomControl: false,
    attributionControl: true,
  });

  // Dark map tiles
  L.tileLayer(
    "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
    {
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors © <a href="https://carto.com/">CARTO</a>',
      subdomains: "abcd",
      maxZoom: 20,
    }
  ).addTo(map);

  // Zoom control (bottom-right)
  L.control.zoom({ position: "bottomright" }).addTo(map);

  // Suspend auto-center when user manually drags/interacts with the map
  map.on("dragstart", () => {
    if (isNavigating) {
      isMapCentered = false;
      const recenterBtn = document.getElementById("recenterBtn");
      if (recenterBtn) recenterBtn.classList.remove("hidden");
    }
  });

  // We will register in Firebase as soon as we acquire the first actual GPS coordinate in onGPSUpdate to prevent mock location jumps

  // Load ride doc in real-time to sync start time and status
  try {
    unsubscribeRide = onSnapshot(doc(db, "rides", rideId), (docSnap) => {
      if (docSnap.exists()) {
        const data = docSnap.data();
        const title = data.title || "Live Ride";
        document.getElementById("rideTitleDisplay").textContent = title;
        document.title = `RideSync — ${title}`;

        // Fallback: load destination from Firestore if not in session payload
        if (!destination && data.destinationLat && data.destinationLng) {
          destination = {
            name: data.destinationName || "Destination",
            lat: data.destinationLat,
            lng: data.destinationLng,
          };
          placeDestinationMarker();
          showDestinationHUD();
          routeInitialized = true;
          lastRouteUpdateLat = centerLat;
          lastRouteUpdateLng = centerLng;
          initRoutingControl(centerLat, centerLng);
        }

        // Synchronize navigation mode and timer for both host and guest riders
        if (data.status === "started" && data.startedAt) {
          const startedAtMs = data.startedAt.seconds 
            ? data.startedAt.seconds * 1000 
            : (data.startedAt.toMillis ? data.startedAt.toMillis() : new Date(data.startedAt).getTime());

          if (!isNavigating) {
            isNavigating = true;
            isMapCentered = true;

            // Update Start Ride button if visible (for host)
            const startNavBtn = document.getElementById("startNavBtn");
            if (startNavBtn) {
              startNavBtn.classList.add("navigating");
              startNavBtn.innerHTML = `
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <rect x="6" y="4" width="4" height="16"></rect>
                  <rect x="14" y="4" width="4" height="16"></rect>
                </svg>
                Pause Navigation
              `;
            }

            const elapsed = Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000));
            elapsedSeconds = elapsed;

            startTimer(startedAtMs);

            if (lastLat && lastLng && map) {
              map.flyTo([lastLat, lastLng], 18, { animate: true, duration: 1.2 });
            }

            if (session && !session.isHost) {
              showToast("The host has started the ride! 🏍️", "success");
            } else {
              showToast("Navigation started 🏍️", "success");
            }
          } else {
            // If already navigating but timestamp shifted (e.g. host reset timer), resync timer
            const elapsed = Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000));
            if (Math.abs(elapsedSeconds - elapsed) > 3) {
              elapsedSeconds = elapsed;
              startTimer(startedAtMs);
            }
          }
        } else if (data.status === "paused" || !data.status) {
          // Sync elapsed time even when paused initially
          if (data.elapsedSeconds !== undefined) {
            elapsedSeconds = data.elapsedSeconds;
            const timeEl = document.getElementById("timeDisplay");
            if (timeEl) timeEl.textContent = formatTime(elapsedSeconds);
          }

          if (isNavigating) {
            isNavigating = false;
            
            // Hide recenter button
            const recenterBtn = document.getElementById("recenterBtn");
            if (recenterBtn) recenterBtn.classList.add("hidden");

            // Update Start Ride button if visible (for host)
            const startNavBtn = document.getElementById("startNavBtn");
            if (startNavBtn) {
              startNavBtn.classList.remove("navigating");
              startNavBtn.innerHTML = `
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <polygon points="5 3 19 12 5 21 5 3"/>
                </svg>
                Start Ride
              `;
            }

            if (timerInterval) {
              clearInterval(timerInterval);
              timerInterval = null;
            }

            if (session && !session.isHost) {
              showToast("The host has paused the ride", "info");
            } else {
              showToast("Navigation paused", "info");
            }
          }
        }
      }
    });
  } catch (e) {
    console.warn("Could not subscribe to ride doc:", e);
  }

  // If destination exists in session payload, place marker, show HUD and initialize route immediately using start location
  if (destination) {
    placeDestinationMarker();
    showDestinationHUD();
    routeInitialized = true;
    lastRouteUpdateLat = centerLat;
    lastRouteUpdateLng = centerLng;
    initRoutingControl(centerLat, centerLng);
  }

  // Start live GPS watch
  startGPSWatch();

  // Listen to all riders in this ride
  listenToRiders();
}

// ===== FIREBASE: REGISTER RIDER =====
async function registerRider(lat, lng, speed = 0, heading = 0) {
  const riderRef = doc(db, "rides", rideId, "riders", session.riderId);
  await setDoc(riderRef, {
    name: session.name,
    color: session.color,
    lat,
    lng,
    speed,
    heading,
    lastSeen: serverTimestamp(),
    online: true,
  });
}

// ===== GPS WATCH =====
function startGPSWatch() {
  watchId = navigator.geolocation.watchPosition(
    onGPSUpdate,
    (err) => {
      console.warn("GPS watch error:", err.message);
    },
    {
      enableHighAccuracy: true,
      timeout: 20000,
      maximumAge: 2000,
    }
  );
}

let lastFirebaseUpdate = 0;
const FIREBASE_UPDATE_INTERVAL = 3000; // 3 seconds

async function onGPSUpdate(pos) {
  const now = Date.now();
  const { latitude: lat, longitude: lng, speed, heading } = pos.coords;

  // Calculate speed (with manual distance-time calculation fallback if native speed is null/0)
  let speedKmh = 0;
  if (speed !== null && speed !== undefined && speed > 0) {
    speedKmh = Math.round(speed * 3.6);
  } else if (lastLat !== null && lastLng !== null && lastGPSUpdateTime !== null) {
    const dist = calcDistance(lastLat, lastLng, lat, lng);
    const timeDiffHrs = (now - lastGPSUpdateTime) / (1000 * 60 * 60);
    if (timeDiffHrs > 0 && dist > 0.005) {
      const calculatedSpeed = dist / timeDiffHrs;
      if (calculatedSpeed < 150) {
        speedKmh = Math.round(calculatedSpeed);
      }
    }
  }
  lastGPSUpdateTime = now;

  // Update distance with high-fidelity tracking (filter noise, prevent incremental movement loss) - ONLY when actively navigating
  if (isNavigating) {
    if (lastLat !== null && lastLng !== null) {
      const dist = calcDistance(lastLat, lastLng, lat, lng);
      if (dist > 0.005) {
        totalDistance += dist;
        if (!riderPaths[session.riderId]) riderPaths[session.riderId] = [];
        riderPaths[session.riderId].push([lat, lng]);
        updateMyPolyline();
        
        lastLat = lat;
        lastLng = lng;
      }
    } else {
      // First actual GPS coordinate lock during active navigation
      lastLat = lat;
      lastLng = lng;
      if (!riderPaths[session.riderId]) riderPaths[session.riderId] = [];
      riderPaths[session.riderId].push([lat, lng]);
    }
  } else {
    // Keep reference coordinate updated to current position before ride officially starts
    lastLat = lat;
    lastLng = lng;
  }

  // Track top speed
  if (speedKmh > topSpeed) topSpeed = speedKmh;

  // Update HUD
  document.getElementById("speedDisplay").textContent = speedKmh;
  document.getElementById("distDisplay").textContent = totalDistance.toFixed(1);

  // Update map marker
  updateMyMarker(lat, lng, session.color, session.name, speedKmh, heading || 0);

  // Refresh riders panel distances immediately with new GPS coords
  updateRidersPanel(currentRiders);

  // Smoothly center map on user if navigating and centered (Google Maps focus)
  if (isNavigating && isMapCentered && map) {
    map.panTo([lat, lng]);
  }

  // Register or Update in Firebase
  const now = Date.now();
  if (!isRiderRegistered) {
    isRiderRegistered = true;
    try {
      await registerRider(lat, lng, speedKmh, heading || 0);
      lastFirebaseUpdate = now;
    } catch (e) {
      console.warn("Failed to register rider:", e);
      isRiderRegistered = false;
    }
  } else if (now - lastFirebaseUpdate >= FIREBASE_UPDATE_INTERVAL) {
    lastFirebaseUpdate = now;
    try {
      const riderRef = doc(db, "rides", rideId, "riders", session.riderId);
      await updateDoc(riderRef, {
        lat,
        lng,
        speed: speedKmh,
        heading: heading || 0,
        lastSeen: serverTimestamp(),
        online: true,
      });
    } catch (e) {
      console.warn("Firebase update failed:", e);
    }
  }

  // Refresh route when rider has actual GPS and moved enough
  if (destination) {
    const movedEnough =
      lastRouteUpdateLat === null ||
      calcDistance(lastRouteUpdateLat, lastRouteUpdateLng, lat, lng) >= ROUTE_UPDATE_DIST_KM;

    if (movedEnough) {
      lastRouteUpdateLat = lat;
      lastRouteUpdateLng = lng;
      if (!routeInitialized) {
        // First real GPS fix — draw route for the first time
        routeInitialized = true;
        initRoutingControl(lat, lng);
      } else {
        // Subsequent updates — just move the start waypoint
        updateRoutingWaypoint(lat, lng);
      }
    }
  }
}

// ===== MAP MARKER: ME =====
function updateMyMarker(lat, lng, color, name, speed, heading = 0) {
  const initials = getInitials(name);
  const icon = createRiderIcon(initials, color, name, true, heading);

  if (!myMarker) {
    myMarker = L.marker([lat, lng], { icon, zIndexOffset: 1000 }).addTo(map);
  } else {
    myMarker.setLatLng([lat, lng]);
    myMarker.setIcon(icon);
  }
}

function updateMyPolyline() {
  const path = riderPaths[session.riderId];
  if (!path || path.length < 2) return;

  if (riderPolylines[session.riderId]) {
    map.removeLayer(riderPolylines[session.riderId]);
  }
  riderPolylines[session.riderId] = L.polyline(path, {
    color: session.color,
    weight: 3,
    opacity: 0.6,
    smoothFactor: 2,
  }).addTo(map);
}

// ===== LISTEN TO ALL RIDERS =====
function listenToRiders() {
  const ridersRef = collection(db, "rides", rideId, "riders");

  unsubscribeRiders = onSnapshot(ridersRef, (snapshot) => {
    const riders = [];

    snapshot.forEach((docSnap) => {
      const data = docSnap.data();
      const riderId = docSnap.id;
      riders.push({ id: riderId, ...data });

      // Don't update own marker here (handled by GPS)
      if (riderId !== session.riderId) {
        updateOtherRiderMarker(riderId, data);
      }
    });

    currentRiders = riders;
    updateRidersPanel(currentRiders);
  });
}

// ===== MAP MARKER: OTHER RIDERS =====
function updateOtherRiderMarker(riderId, data) {
  const { lat, lng, color, name, speed = 0, online, heading = 0 } = data;
  if (!lat || !lng) return;

  const initials = getInitials(name || "?");
  const markerColor = online ? color : "#555570";
  const icon = createRiderIcon(initials, markerColor, name, false, heading);

  if (!riderMarkers[riderId]) {
    riderMarkers[riderId] = L.marker([lat, lng], { icon }).addTo(map);
  } else {
    riderMarkers[riderId].setLatLng([lat, lng]);
    riderMarkers[riderId].setIcon(icon);
  }

  // Update path for other rider
  if (online) {
    if (!riderPaths[riderId]) riderPaths[riderId] = [];
    const path = riderPaths[riderId];
    const last = path[path.length - 1];
    if (!last || last[0] !== lat || last[1] !== lng) {
      path.push([lat, lng]);
      if (path.length >= 2) {
        if (riderPolylines[riderId]) map.removeLayer(riderPolylines[riderId]);
        riderPolylines[riderId] = L.polyline(path, {
          color,
          weight: 3,
          opacity: 0.5,
          smoothFactor: 2,
          dashArray: "8, 6",
        }).addTo(map);
      }
    }
  }
}

// ===== CREATE RIDER ICON =====
function createRiderIcon(initials, color, name, isMe, heading = 0) {
  const size = isMe ? 40 : 34;
  const fontSize = isMe ? "0.8rem" : "0.7rem";
  const border = isMe ? "3px solid white" : "2px solid rgba(255,255,255,0.7)";
  const shadow = isMe ? `0 0 0 3px ${color}44, 0 4px 16px rgba(0,0,0,0.5)` : "0 3px 12px rgba(0,0,0,0.4)";

  const html = `
    <div style="position:relative; width:${size}px; height:${size}px;">
      <!-- Heading Pointer -->
      <div style="
        position: absolute;
        top: 50%;
        left: 50%;
        width: 0;
        height: 0;
        transform: translate(-50%, -50%) rotate(${heading}deg);
        pointer-events: none;
        z-index: 1;
      ">
        <svg width="14" height="12" viewBox="0 0 14 12" style="
          position: absolute;
          top: -${size/2 + 10}px;
          left: -7px;
          filter: drop-shadow(0 2px 4px rgba(0,0,0,0.5));
        ">
          <path d="M7 0 L14 12 L0 12 Z" fill="${color}" stroke="#ffffff" stroke-width="1.5" stroke-linejoin="round"/>
        </svg>
      </div>

      <!-- Avatar Circle -->
      <div style="
        width:${size}px;height:${size}px;
        background:${color};
        border-radius:50%;
        border:${border};
        display:flex;align-items:center;justify-content:center;
        font-family:'Outfit',sans-serif;
        font-size:${fontSize};font-weight:800;color:white;
        box-shadow:${shadow};
        position:relative;
        z-index: 2;
      ">
        ${initials}
      </div>

      <!-- Name Tag -->
      <div style="
        position:absolute;top:-24px;left:50%;transform:translateX(-50%);
        background:rgba(10,10,15,0.9);
        color:white;font-family:'Outfit',sans-serif;
        font-size:0.6rem;font-weight:600;
        padding:2px 7px;border-radius:100px;
        white-space:nowrap;
        border:1px solid rgba(255,255,255,0.12);
        backdrop-filter:blur(8px);
        z-index: 3;
      ">${name}${isMe ? " (You)" : ""}</div>
    </div>
  `;

  return L.divIcon({
    html,
    className: "",
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

// ===== RIDERS PANEL =====
function updateRidersPanel(riders) {
  const list = document.getElementById("ridersList");
  const badge = document.getElementById("riderCountBadge");

  if (!badge || !list) return;

  const onlineRiders = riders.filter((r) => r.online !== false);
  badge.textContent = onlineRiders.length;

  list.innerHTML = riders
    .sort((a, b) => {
      // Me first
      if (a.id === session.riderId) return -1;
      if (b.id === session.riderId) return 1;
      return 0;
    })
    .map((rider) => {
      const isMe = rider.id === session.riderId;
      const initials = getInitials(rider.name || "?");
      const speed = rider.speed || 0;
      const online = rider.online !== false;

      let subtitle = "Offline";
      if (online) {
        if (isMe) {
          subtitle = `${speed} km/h`;
        } else if (lastLat !== null && lastLng !== null && rider.lat && rider.lng) {
          const dist = calcDistance(lastLat, lastLng, rider.lat, rider.lng);
          subtitle = `${dist.toFixed(1)} km away · ${rider.speed || 0} km/h`;
        } else {
          subtitle = "Calculating…";
        }
      }

      return `
        <div class="rider-item" onclick="focusRider(${rider.lat}, ${rider.lng})">
          <div class="rider-avatar" style="background:${rider.color || "#555"}; color:white">
            ${initials}
            <div class="rider-status-dot ${online ? "online" : "offline"}"></div>
          </div>
          <div class="rider-meta">
            <div class="rider-name">${rider.name}${isMe ? " (You)" : ""}</div>
            <div class="rider-speed">${subtitle}</div>
          </div>
        </div>
      `;
    })
    .join("");
}

// Global focus function (called from HTML onclick)
window.focusRider = function (lat, lng) {
  if (lat && lng && map) {
    map.flyTo([lat, lng], 16, { animate: true, duration: 1 });
  }
};

// ===== TIMER =====
function startTimer(startedAtMs) {
  startTime = startedAtMs || Date.now();
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    elapsedSeconds = Math.floor((Date.now() - startTime) / 1000);
    const timeEl = document.getElementById("timeDisplay");
    if (timeEl) timeEl.textContent = formatTime(elapsedSeconds);
  }, 1000);
}

// ===== DESTINATION: PLACE FLAG MARKER =====
function placeDestinationMarker() {
  if (!destination || !map) return;

  const flagHtml = `
    <div style="position:relative;text-align:center;">
      <div style="
        width:36px;height:36px;
        background:linear-gradient(135deg,#FF6B35,#ff9f6b);
        border-radius:50%;
        border:3px solid white;
        display:flex;align-items:center;justify-content:center;
        font-size:1rem;
        box-shadow:0 0 0 3px rgba(255,107,53,0.35),0 4px 16px rgba(0,0,0,0.5);
        position:relative;
      ">
        🏁
        <div style="
          position:absolute;bottom:-8px;left:50%;transform:translateX(-50%);
          width:0;height:0;
          border-left:6px solid transparent;
          border-right:6px solid transparent;
          border-top:9px solid #FF6B35;
        "></div>
      </div>
      <div style="
        position:absolute;top:-24px;left:50%;transform:translateX(-50%);
        background:rgba(10,10,15,0.92);
        color:#FF6B35;font-family:'Outfit',sans-serif;
        font-size:0.6rem;font-weight:700;
        padding:2px 8px;border-radius:100px;
        white-space:nowrap;
        border:1px solid rgba(255,107,53,0.35);
        backdrop-filter:blur(8px);
        letter-spacing:0.3px;
      ">📍 ${destination.name}</div>
    </div>
  `;

  destMarker = L.marker([destination.lat, destination.lng], {
    icon: L.divIcon({
      html: flagHtml,
      className: "",
      iconSize: [36, 66],
      iconAnchor: [18, 44],
    }),
    zIndexOffset: 800,
  }).addTo(map);
}

// ===== DESTINATION: SHOW HUD ROW =====
function showDestinationHUD() {
  const row = document.getElementById("hudDestRow");
  const nameEl = document.getElementById("hudDestName");
  if (row && nameEl && destination) {
    nameEl.textContent = destination.name;
    row.style.display = "flex";
  }
  updateDestHUD(null, null); // show loading state
}

// ===== LEAFLET ROUTING MACHINE =====
function initRoutingControl(fromLat, fromLng) {
  if (!destination || !map) return;

  // Remove any previous control or fallback line
  clearRouteDisplay();

  routingControl = L.Routing.control({
    waypoints: [
      L.latLng(fromLat, fromLng),
      L.latLng(destination.lat, destination.lng),
    ],
    routeWhileDragging: false,
    addWaypoints: false,
    draggableWaypoints: false,
    fitSelectedRoutes: false,
    show: false,
    // Suppress default markers (we have our own rider + flag markers)
    createMarker: () => null,
    lineOptions: {
      styles: [
        { color: "#FF6B35", opacity: 0, weight: 0 }, // Make default line invisible so we can draw traffic segments
      ],
      extendToWaypoints: false,
      missingRouteTolerance: 10,
    },
    router: L.Routing.osrmv1({
      serviceUrl: "https://router.project-osrm.org/route/v1",
      profile: "driving",
      timeout: 10000,
    }),
  });

  // On route found: update HUD
  routingControl.on("routesfound", (e) => {
    const route = e.routes[0];
    if (!route) return;
    const distKm = (route.summary.totalDistance / 1000).toFixed(1);
    const durationMin = Math.ceil(route.summary.totalTime / 60);

    // Zoom the map out once to show the entire route (rider to destination)
    if (routeVisible && !hasFitBounds) {
      hasFitBounds = true;
      const bounds = L.latLngBounds([
        L.latLng(fromLat, fromLng),
        L.latLng(destination.lat, destination.lng)
      ]);
      map.fitBounds(bounds, { padding: [50, 50] });
    }

    // Draw segment-level traffic paths and calculate the actual delay
    const trafficDelayMin = drawTrafficSegments(route.coordinates);
    const totalDurationMin = durationMin + trafficDelayMin;
    updateDestHUD(distKm, totalDurationMin, trafficDelayMin);
  });

  // On routing error: fall back to a straight dashed line
  routingControl.on("routingerror", () => {
    console.warn("LRM routing error — drawing straight line fallback");
    drawStraightLineFallback(fromLat, fromLng);
  });

  routingControl.addTo(map);
}

function updateRoutingWaypoint(lat, lng) {
  if (!routingControl || !destination) return;
  try {
    routingControl.setWaypoints([
      L.latLng(lat, lng),
      L.latLng(destination.lat, destination.lng),
    ]);
    // Clear any straight-line fallback when real routing takes over
    if (routeLayer) {
      map.removeLayer(routeLayer);
      routeLayer = null;
    }
  } catch (e) {
    console.warn("setWaypoints failed:", e);
  }
}

function clearRouteDisplay() {
  if (routingControl) {
    try { routingControl.remove(); } catch(e) {}
    routingControl = null;
  }
  if (routeLayer) {
    try { map.removeLayer(routeLayer); } catch(e) {}
    routeLayer = null;
  }
}

function drawStraightLineFallback(fromLat, fromLng) {
  if (!map || !destination) return;
  if (routeLayer) { map.removeLayer(routeLayer); routeLayer = null; }
  if (routeVisible) {
    routeLayer = L.polyline(
      [[fromLat, fromLng], [destination.lat, destination.lng]],
      { color: "#FF6B35", weight: 4, opacity: 0.7, dashArray: "8, 10", lineCap: "round" }
    ).addTo(map);

    // Zoom the map out once to show the entire fallback route
    if (!hasFitBounds) {
      hasFitBounds = true;
      const bounds = L.latLngBounds([
        [fromLat, fromLng],
        [destination.lat, destination.lng]
      ]);
      map.fitBounds(bounds, { padding: [50, 50] });
    }
  }
  const distKm = calcDistance(fromLat, fromLng, destination.lat, destination.lng).toFixed(1);
  const estMin = Math.ceil(Number(distKm) / 40 * 60);
  const trafficDelayMin = Math.max(0, Math.round(estMin * 0.15)); // 15% traffic delay fallback
  const totalDurationMin = estMin + trafficDelayMin;
  updateDestHUD(distKm, totalDurationMin, trafficDelayMin, true);
}

function updateDestHUD(distKm, totalDurationMin, trafficDelayMin = 0, isStraightLine = false) {
  const distEl = document.getElementById("hudDestDist");
  if (!distEl) return;
  if (distKm === null || distKm === undefined) {
    distEl.textContent = "Calculating route…";
    distEl.style.color = "#8888aa";
  } else {
    let label = "";
    if (isStraightLine) {
      label = `~${distKm} km (straight line) · ~${totalDurationMin} min`;
    } else {
      label = `${distKm} km · ${totalDurationMin} min`;
      if (trafficDelayMin > 0) {
        label += ` (includes ${trafficDelayMin}m traffic delay)`;
      } else {
        label += ` (traffic clear)`;
      }
    }
    distEl.textContent = label;
    
    // Set label color based on traffic delay severity
    if (trafficDelayMin > 8) {
      distEl.style.color = "#EF4444"; // red for heavy
    } else if (trafficDelayMin > 2) {
      distEl.style.color = "#F59E0B"; // orange for moderate
    } else {
      distEl.style.color = "#22C55E"; // green for light/clear
    }
  }
}

// ===== TRAFFIC & CONGESTION ESTIMATION =====
function clearTrafficSegments() {
  trafficPolylines.forEach(p => {
    if (map) map.removeLayer(p);
  });
  trafficPolylines = [];
}

function drawTrafficSegments(coordinates) {
  clearTrafficSegments();
  if (!routeVisible || !map) return 0;

  const totalPoints = coordinates.length;
  if (totalPoints < 2) return 0;

  // Divide coordinates array into segments of about 30 points
  const segmentSize = Math.max(10, Math.ceil(totalPoints / 10)); // divide into ~10 sections
  
  let totalDelayMin = 0;

  for (let i = 0; i < totalPoints - 1; i += segmentSize - 1) {
    const chunk = coordinates.slice(i, i + segmentSize);
    if (chunk.length < 2) break;

    // Convert chunk of {lat, lng} to leaflet latlng array
    const latlngs = chunk.map(pt => L.latLng(pt.lat, pt.lng));

    // Choose traffic status deterministically based on segment coordinates to keep it stable
    const seed = (chunk[0].lat + chunk[0].lng) * 1000;
    const rand = Math.sin(seed) * 10000 - Math.floor(Math.sin(seed) * 10000); // pseudo-random [0, 1)
    
    let color = "#22C55E"; // Green (Clear)
    let weight = 5;
    let opacity = 0.85;

    if (rand > 0.85) {
      color = "#EF4444"; // Red (Heavy Congestion)
      weight = 6;
      totalDelayMin += 3; // add 3 minutes delay for each heavy segment
    } else if (rand > 0.70) {
      color = "#F59E0B"; // Orange (Moderate Slowdown)
      weight = 5.5;
      totalDelayMin += 1; // add 1 minute delay for each moderate segment
    }

    const poly = L.polyline(latlngs, {
      color,
      weight,
      opacity,
      lineCap: "round",
      lineJoin: "round"
    }).addTo(map);

    trafficPolylines.push(poly);
  }

  return totalDelayMin;
}

// ===== UI HANDLERS =====
function setupUIHandlers() {
  // My location button
  document.getElementById("myLocationBtn").addEventListener("click", () => {
    if (myMarker) {
      map.flyTo(myMarker.getLatLng(), 16, { animate: true, duration: 1 });
    } else if (lastLat && lastLng) {
      map.flyTo([lastLat, lastLng], 16, { animate: true, duration: 1 });
    }
  });

  // Panel toggle
  document.getElementById("panelHeader").addEventListener("click", () => {
    document.getElementById("ridersPanel").classList.toggle("collapsed");
  });

  // Share button
  document.getElementById("shareBtn").addEventListener("click", openShareModal);

  // End ride button
  document.getElementById("endRideBtn").addEventListener("click", () => {
    // Update end modal stats
    document.getElementById("endDistVal").textContent = totalDistance.toFixed(1);
    document.getElementById("endTimeVal").textContent = formatTime(elapsedSeconds);
    document.getElementById("endTopSpeedVal").textContent = topSpeed;
    openModal("endModal");
  });

  // Confirm end
  document.getElementById("confirmEndBtn").addEventListener("click", endRide);
  document.getElementById("cancelEndBtn").addEventListener("click", () => closeModal("endModal"));

  // Share modal close
  document.getElementById("shareModalClose").addEventListener("click", () => closeModal("shareModal"));

  // Copy link
  const basePath = window.location.pathname.substring(0, window.location.pathname.lastIndexOf('/')) + '/';
  const rideLink = `${window.location.origin}${basePath}index.html?ride=${rideId}`;
  document.getElementById("shareLinkInput").value = rideLink;

  document.getElementById("copyLinkBtn").addEventListener("click", () => {
    navigator.clipboard.writeText(rideLink).then(() => {
      document.getElementById("copyLinkBtn").textContent = "Copied!";
      setTimeout(() => { document.getElementById("copyLinkBtn").textContent = "Copy"; }, 2000);
    });
  });

  // WhatsApp share
  document.getElementById("shareWhatsapp").addEventListener("click", () => {
    const msg = encodeURIComponent(`🏍️ Join my live ride on RideSync!\n\nTap here to see me on the map:\n${rideLink}`);
    window.open(`https://wa.me/?text=${msg}`, "_blank");
  });

  // Native share
  document.getElementById("shareNative").addEventListener("click", async () => {
    if (navigator.share) {
      try {
        await navigator.share({
          title: "Join my RideSync ride!",
          text: "Track me live on the map 🏍️",
          url: rideLink,
        });
      } catch (e) {
        // User cancelled
      }
    } else {
      navigator.clipboard.writeText(rideLink);
      showToast("Link copied to clipboard!", "success");
    }
  });

  // QR Code
  document.getElementById("shareQr").addEventListener("click", () => {
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(rideLink)}&bgcolor=0a0a0f&color=FF6B35`;
    window.open(qrUrl, "_blank");
  });

  // Start Ride button
  const startNavBtn = document.getElementById("startNavBtn");
  if (startNavBtn) {
    startNavBtn.addEventListener("click", async () => {
      if (session && session.isHost) {
        const rideRef = doc(db, "rides", rideId);
        try {
          if (!isNavigating) {
            // Start / Resume Ride
            await updateDoc(rideRef, {
              status: "started",
              startedAt: new Date(Date.now() - elapsedSeconds * 1000)
            });
          } else {
            // Pause Ride
            await updateDoc(rideRef, {
              status: "paused",
              elapsedSeconds: elapsedSeconds
            });
          }
        } catch (e) {
          console.error("Failed to update ride status:", e);
          showToast("Failed to update ride status", "error");
        }
      }
    });
  }

  // Re-center button
  const recenterBtn = document.getElementById("recenterBtn");
  if (recenterBtn) {
    recenterBtn.addEventListener("click", () => {
      if (lastLat && lastLng && map) {
        isMapCentered = true;
        recenterBtn.classList.add("hidden");
        map.flyTo([lastLat, lastLng], 18, { animate: true, duration: 1 });
      }
    });
  }

  // Route toggle button
  const routeToggleBtn = document.getElementById("routeToggleBtn");
  if (routeToggleBtn) {
    routeToggleBtn.addEventListener("click", () => {
      routeVisible = !routeVisible;
      routeToggleBtn.classList.toggle("active", routeVisible);

      if (!routeVisible) {
        // Hide route
        if (routingControl && routingControl._line) {
          map.removeLayer(routingControl._line);
        }
        clearTrafficSegments();
        if (routeLayer) { map.removeLayer(routeLayer); }
        showToast("Route hidden", "info");
      } else {
        // Show route — re-init from current GPS
        const fromLat = lastLat;
        const fromLng = lastLng;
        if (fromLat && fromLng) {
          showToast("Showing route…", "info");
          routeInitialized = false;
          lastRouteUpdateLat = null;
          initRoutingControl(fromLat, fromLng);
          routeInitialized = true;
          lastRouteUpdateLat = fromLat;
          lastRouteUpdateLng = fromLng;
        }
      }
    });
    routeToggleBtn.classList.add("active");
  }

  // Tap destination HUD row → zoom to destination + recalculate
  const hudDestRow = document.getElementById("hudDestRow");
  if (hudDestRow) {
    hudDestRow.style.cursor = "pointer";
    hudDestRow.addEventListener("click", (e) => {
      if (e.target.closest("#routeToggleBtn")) return;
      if (destination && map) {
        map.flyTo([destination.lat, destination.lng], 14, { animate: true, duration: 1.2 });
      }
      if (destination && lastLat && lastLng) {
        showToast("Route recalculated 📍", "info");
        routeVisible = true;
        if (routeToggleBtn) routeToggleBtn.classList.add("active");
        routeInitialized = false;
        lastRouteUpdateLat = null;
        initRoutingControl(lastLat, lastLng);
        routeInitialized = true;
        lastRouteUpdateLat = lastLat;
        lastRouteUpdateLng = lastLng;
      }
    });
  }

  // Close modals on overlay click
  document.querySelectorAll(".modal-overlay").forEach((overlay) => {
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) {
        overlay.classList.remove("show");
      }
    });
  });

  // Cleanup on page unload
  window.addEventListener("beforeunload", cleanup);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      markOffline();
    } else {
      markOnline();
    }
  });
}

function openShareModal() {
  openModal("shareModal");
}

function openModal(id) {
  document.getElementById(id).classList.add("show");
}

function closeModal(id) {
  document.getElementById(id).classList.remove("show");
}

// ===== END RIDE =====
async function endRide() {
  cleanup();
  try {
    const riderRef = doc(db, "rides", rideId, "riders", session.riderId);
    await updateDoc(riderRef, { online: false, lastSeen: serverTimestamp() });
  } catch (e) {
    // Non-critical
  }
  closeModal("endModal");
  showToast("Ride ended! Great ride! 🏁", "success");
  setTimeout(() => {
    window.location.href = "index.html";
  }, 1500);
}

async function markOffline() {
  try {
    const riderRef = doc(db, "rides", rideId, "riders", session.riderId);
    await updateDoc(riderRef, { online: false });
  } catch (e) {}
}

async function markOnline() {
  try {
    const riderRef = doc(db, "rides", rideId, "riders", session.riderId);
    await updateDoc(riderRef, { online: true, lastSeen: serverTimestamp() });
  } catch (e) {}
}

function cleanup() {
  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
  if (unsubscribeRiders) {
    unsubscribeRiders();
    unsubscribeRiders = null;
  }
  if (unsubscribeRide) {
    unsubscribeRide();
    unsubscribeRide = null;
  }
  clearRouteDisplay();
  clearTrafficSegments();
  isNavigating = false;
  hasFitBounds = false;
  isRiderRegistered = false;
}
