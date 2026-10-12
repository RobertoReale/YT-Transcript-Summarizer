// Seek bridge for the side panel: a click on a [m:ss] link in the summary moves
// the player of the tab the summary belongs to. The side panel follows YouTube's
// SPA navigation itself (tabs.onUpdated), so this script has nothing else to do.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'SEEK_TO' || typeof message.seconds !== 'number') return;
  const video = document.querySelector('video');
  if (video) {
    video.currentTime = message.seconds;
    if (video.paused) video.play().catch(() => {});
  }
  sendResponse({ success: !!video });
});
