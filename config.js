// Firebase project for score sync. The web API key is public by design --
// access control lives in firestore.rules (room-code path + shape checks).
// The family room code is NOT baked in: it rides the shared link (?room=...)
// and sticks in localStorage on first open.
window.GAUNTLET_CONFIG = {
  firebase: { projectId: "daily-gauntlet", apiKey: "AIzaSyDhE-pKgEVvaD13bWz27Dot8CXZZs7aTsM" },
  room: "",
};
