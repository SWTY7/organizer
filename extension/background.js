/**
 * The service worker does almost nothing on purpose.
 *
 * Capture runs in manager.html, a normal extension page in a normal tab, which
 * inherits the same host permissions. A tab does not get torn down after 30
 * seconds of idle the way an MV3 service worker does, and an export of a few
 * hundred conversations takes minutes. Running the work in a page you can see
 * also means progress is visible and cancelling is just closing the tab.
 */

const MANAGER = 'manager.html';

chrome.action.onClicked.addListener(async () => {
  const url = chrome.runtime.getURL(MANAGER);
  // Reuse an already-open manager rather than piling up tabs.
  const [existing] = await chrome.tabs.query({ url });
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true });
    await chrome.windows.update(existing.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url });
  }
});
