// ===== FIREBASE CONFIGURATION =====
// 
// IMPORTANT: You need to create a free Firebase project to use this app.
// 
// Steps:
// 1. Go to https://console.firebase.google.com/
// 2. Click "Add Project" → give it a name like "RideSync"
// 3. Disable Google Analytics (optional) → Click "Create Project"
// 4. Click "Web" icon (</>) to add a Web App
// 5. Register app with name "RideSync" → Copy the config below
// 6. Go to Firestore → "Create database" → Start in "test mode" → Choose your region
// 7. Replace the config values below with YOUR project's values
//
// Your config is found in: Firebase Console → Project Settings → Your apps → SDK setup

export const firebaseConfig = {
  apiKey: "AIzaSyDl3XV6qolC8YH6hMTzioJyvXI4fy_kiV4",
  authDomain: "ridesync-4e463.firebaseapp.com",
  projectId: "ridesync-4e463",
  storageBucket: "ridesync-4e463.firebasestorage.app",
  messagingSenderId: "475964161615",
  appId: "1:475964161615:web:8d620df51a85919de4f43a",
  measurementId: "G-2J7FVKVPEY"
};

// ===== FIRESTORE DATA STRUCTURE =====
//
// Collection: "rides"
//   Document: "{rideId}"
//     Fields:
//       - title: string
//       - createdAt: timestamp
//       - active: boolean
//     Sub-collection: "riders"
//       Document: "{riderId}"  (auto UUID)
//         Fields:
//           - name: string
//           - color: string (hex)
//           - lat: number
//           - lng: number
//           - speed: number
//           - heading: number
//           - lastSeen: timestamp
//           - online: boolean
