// ===== HOME.JS — Create & Join Ride Logic =====

import {
  collection,
  doc,
  setDoc,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

import {
  generateId,
  showToast,
  saveRiderSession,
  getUrlParam,
} from "./utils.js";

// ===== UNICODE-SAFE BASE64 ENCODING =====
// btoa() only handles Latin-1. TextEncoder converts any Unicode to UTF-8 bytes first.
function unicodeToUrlBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}


export function initHome(db) {
  // ===== STATE =====
  let createColor = "#FF6B35";
  let joinColor = "#00D4FF";

  // ===== ELEMENTS =====
  const createNameEl = document.getElementById("createName");
  const rideTitleEl = document.getElementById("rideTitle");
  const createRideBtn = document.getElementById("createRideBtn");
  const joinNameEl = document.getElementById("joinName");
  const joinLinkEl = document.getElementById("joinLink");
  const joinRideBtn = document.getElementById("joinRideBtn");
  const createColors = document.getElementById("createColors");
  const joinColors = document.getElementById("joinColors");

  // ===== DESTINATION GEOCODER ELEMENTS =====
  const destInput = document.getElementById("destinationInput");
  const destSuggestions = document.getElementById("destSuggestions");
  const destLatEl = document.getElementById("destLat");
  const destLngEl = document.getElementById("destLng");
  const destNameEl = document.getElementById("destName");
  const destSelectedBadge = document.getElementById("destSelectedBadge");
  const destSelectedText = document.getElementById("destSelectedText");
  const destClearBtn = document.getElementById("destClearBtn");

  // ===== PRE-FILL JOIN LINK FROM URL =====
  const rideIdFromUrl = getUrlParam("ride");
  if (rideIdFromUrl) {
    joinLinkEl.value = rideIdFromUrl;
    setTimeout(() => {
      document.getElementById("joinCard").scrollIntoView({ behavior: "smooth" });
      joinNameEl.focus();
    }, 300);
  }

  // ===== COLOR PICKERS =====
  function setupColorPicker(container, onSelect) {
    container.querySelectorAll(".color-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        container.querySelectorAll(".color-btn").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        onSelect(btn.dataset.color);
      });
    });
  }

  setupColorPicker(createColors, (color) => { createColor = color; });
  setupColorPicker(joinColors, (color) => { joinColor = color; });

  // ===== DESTINATION AUTOCOMPLETE (NOMINATIM) =====
  let nominatimTimer = null;
  let selectedDestination = null; // { name, lat, lng }

  function clearDestination() {
    selectedDestination = null;
    if (destLatEl) destLatEl.value = "";
    if (destLngEl) destLngEl.value = "";
    if (destNameEl) destNameEl.value = "";
    if (destInput) destInput.value = "";
    if (destSelectedBadge) destSelectedBadge.classList.remove("visible");
    if (destSelectedText) destSelectedText.textContent = "";
    closeSuggestions();
  }

  function closeSuggestions() {
    if (!destSuggestions) return;
    destSuggestions.classList.remove("open");
    destSuggestions.innerHTML = "";
  }

  function selectDestination(result) {
    const fullName = result.display_name;
    const shortName = fullName.split(",").slice(0, 2).join(",").trim();
    selectedDestination = {
      name: shortName,
      lat: parseFloat(result.lat),
      lng: parseFloat(result.lon),
    };
    if (destLatEl) destLatEl.value = selectedDestination.lat;
    if (destLngEl) destLngEl.value = selectedDestination.lng;
    if (destNameEl) destNameEl.value = selectedDestination.name;
    if (destInput) destInput.value = shortName;
    if (destSelectedText) destSelectedText.textContent = shortName;
    if (destSelectedBadge) destSelectedBadge.classList.add("visible");
    closeSuggestions();
  }

  async function fetchNominatimSuggestions(query) {
    if (!destSuggestions) return;
    destSuggestions.innerHTML = `<div class="dest-loading">🔍 Searching…</div>`;
    destSuggestions.classList.add("open");
    try {
      const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=5&addressdetails=1`;
      const res = await fetch(url, {
        headers: { "Accept-Language": "en", "User-Agent": "RideSync/1.0" },
      });
      const data = await res.json();

      if (!data || data.length === 0) {
        destSuggestions.innerHTML = `<div class="dest-loading">No places found. Try a different name.</div>`;
        return;
      }

      destSuggestions.innerHTML = data.map((r, i) => {
        const parts = r.display_name.split(",");
        const mainName = parts.slice(0, 2).join(",").trim();
        const detail = parts.slice(2, 4).join(",").trim();
        return `
          <div class="dest-suggestion-item" tabindex="0" data-index="${i}">
            <span class="dest-suggestion-icon">📍</span>
            <div>
              <div class="dest-suggestion-name">${mainName}</div>
              ${detail ? `<div class="dest-suggestion-detail">${detail}</div>` : ""}
            </div>
          </div>
        `;
      }).join("");

      destSuggestions.querySelectorAll(".dest-suggestion-item").forEach((item, i) => {
        item.addEventListener("click", () => selectDestination(data[i]));
        item.addEventListener("keydown", (e) => {
          if (e.key === "Enter") selectDestination(data[i]);
        });
      });
    } catch (e) {
      destSuggestions.innerHTML = `<div class="dest-loading">Search failed. Check your connection.</div>`;
    }
  }

  if (destInput) {
    destInput.addEventListener("input", () => {
      const q = destInput.value.trim();
      // If the user has already selected and the value matches, don't re-search
      if (selectedDestination && destInput.value === selectedDestination.name) return;
      // Reset selection when user edits
      selectedDestination = null;
      if (destLatEl) destLatEl.value = "";
      if (destLngEl) destLngEl.value = "";
      if (destNameEl) destNameEl.value = "";
      if (destSelectedBadge) destSelectedBadge.classList.remove("visible");

      clearTimeout(nominatimTimer);
      if (q.length < 3) { closeSuggestions(); return; }
      nominatimTimer = setTimeout(() => fetchNominatimSuggestions(q), 500);
    });

    destInput.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeSuggestions();
    });

    document.addEventListener("click", (e) => {
      if (!destInput.contains(e.target) && !destSuggestions.contains(e.target)) {
        closeSuggestions();
      }
    });
  }

  if (destClearBtn) {
    destClearBtn.addEventListener("click", clearDestination);
  }

  // ===== CREATE RIDE =====
  createRideBtn.addEventListener("click", async () => {
    const name = createNameEl.value.trim();
    if (!name) {
      showToast("Please enter your rider name 🏍️", "error");
      createNameEl.focus();
      return;
    }

    // Validate destination (mandatory)
    if (!selectedDestination) {
      showToast("Please set a destination 📍", "error");
      destInput.focus();
      return;
    }

    setLoading(createRideBtn, true);

    try {
      const rideId = generateId(12);
      const riderId = generateId(20);
      const rideTitle = rideTitleEl.value.trim() || "Squad Ride";

      // Build ride document with mandatory destination
      const rideDocData = {
        title: rideTitle,
        createdAt: serverTimestamp(),
        active: true,
        createdBy: riderId,
        destinationName: selectedDestination.name,
        destinationLat: selectedDestination.lat,
        destinationLng: selectedDestination.lng,
      };

      await setDoc(doc(db, "rides", rideId), rideDocData);

      // Store session in storage — handles unicode naturally
      const sessionData = {
        riderId,
        rideId,
        name,
        color: createColor,
        isHost: true,
        destination: {
          name: selectedDestination.name,
          lat: selectedDestination.lat,
          lng: selectedDestination.lng,
        },
      };
      sessionStorage.setItem("ridesync_session", JSON.stringify(sessionData));
      localStorage.setItem("ridesync_rider", JSON.stringify(sessionData));

      showToast("Ride created! Starting map...", "success");

      setTimeout(() => {
        // Encode session to URL param for redundancy (handles private tabs / storage blocks)
        const encodedSession = unicodeToUrlBase64(JSON.stringify(sessionData));
        window.location.href = `ride.html?s=${encodedSession}`;
      }, 800);
    } catch (err) {
      console.error("Create ride error:", err);
      showToast("Failed to create ride. Check your Firebase config.", "error");
      setLoading(createRideBtn, false);
    }
  });

  // ===== JOIN RIDE =====
  joinRideBtn.addEventListener("click", async () => {
    const name = joinNameEl.value.trim();
    const linkOrId = joinLinkEl.value.trim();

    if (!name) {
      showToast("Please enter your rider name 🏍️", "error");
      joinNameEl.focus();
      return;
    }

    if (!linkOrId) {
      showToast("Please enter the ride link or ID", "error");
      joinLinkEl.focus();
      return;
    }

    setLoading(joinRideBtn, true);

    // Extract ride ID from URL or use directly
    let rideId = linkOrId;
    try {
      const url = new URL(linkOrId);
      rideId = url.searchParams.get("ride") || linkOrId;
    } catch {
      // Not a URL, use as-is
    }
    rideId = rideId.trim();

    try {
      const riderId = generateId(20);

      // Store session in storage
      const sessionData = {
        riderId,
        rideId,
        name,
        color: joinColor,
        isHost: false,
      };
      sessionStorage.setItem("ridesync_session", JSON.stringify(sessionData));
      localStorage.setItem("ridesync_rider", JSON.stringify(sessionData));

      showToast("Joining ride... Hold tight! 🏍️", "success");

      setTimeout(() => {
        // Encode session to URL param for redundancy
        const encodedSession = unicodeToUrlBase64(JSON.stringify(sessionData));
        window.location.href = `ride.html?s=${encodedSession}`;
      }, 600);
    } catch (err) {
      console.error("Join ride error:", err);
      showToast("Failed to join ride. Try again.", "error");
      setLoading(joinRideBtn, false);
    }
  });

  // ===== ENTER KEY SUPPORT =====
  createNameEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") rideTitleEl.focus();
  });
  rideTitleEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") destInput ? destInput.focus() : createRideBtn.click();
  });
  if (destInput) {
    destInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !destSuggestions.classList.contains("open")) createRideBtn.click();
    });
  }
  joinNameEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") joinLinkEl.focus();
  });
  joinLinkEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") joinRideBtn.click();
  });

  // ===== HELPERS =====
  function setLoading(btn, loading) {
    btn.disabled = loading;
    if (loading) {
      btn.classList.add("loading");
      btn.dataset.originalText = btn.innerHTML;
      btn.innerHTML = `
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none" style="animation: spin 1s linear infinite">
          <circle cx="10" cy="10" r="8" stroke="currentColor" stroke-width="2" stroke-dasharray="25 13"/>
        </svg>
        Loading...
      `;
    } else {
      btn.disabled = false;
      btn.classList.remove("loading");
      if (btn.dataset.originalText) btn.innerHTML = btn.dataset.originalText;
    }
  }
}
