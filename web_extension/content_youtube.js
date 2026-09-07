chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GET_VIDEO_INFO') {
    const video = document.querySelector('video');
    const titleEl = document.querySelector('title');
    const urlParams = new URLSearchParams(window.location.search);
    
    sendResponse({
      videoId: urlParams.get('v'),
      currentTime: video ? video.currentTime : 0,
      duration: video ? video.duration : 0,
      title: titleEl ? titleEl.textContent.replace(/^\(\d+\)\s*/, '').replace(/ - YouTube$/, '') : document.title
    });
    return true; // Needed if async, but we send synchronously
  }

  if (message.type === 'SEEK_TO' && typeof message.seconds === 'number') {
    const player = document.querySelector('#movie_player');
    if (player && typeof player.seekTo === 'function') {
      player.seekTo(message.seconds, true);
    } else {
      const video = document.querySelector('video');
      if (video) {
        video.currentTime = message.seconds;
      }
    }
    sendResponse({ success: true });
    return true;
  }
});

document.addEventListener('yt-navigate-finish', () => {
  const urlParams = new URLSearchParams(window.location.search);
  const videoId = urlParams.get('v');
  if (videoId) {
    chrome.runtime.sendMessage({ type: 'YOUTUBE_NAVIGATED', videoId });
  }
});
