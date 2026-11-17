/** The Electron shell reserves navigation and conversation space around pages. */
export const isIntegratedDesktop = document.documentElement.classList.contains('electron-mode');

// Reserve only the small reopen control when the conversation is tucked away.
if (isIntegratedDesktop) {
  window.addEventListener('message', (event) => {
    if (
      event.source !== window.parent ||
      event.data?.type !== 'ai-desktop:chat-layout' ||
      typeof event.data.open !== 'boolean'
    )
      return;
    document.documentElement.classList.toggle('conversation-closed', !event.data.open);
  });
  window.parent.postMessage({ type: 'ai-desktop:chat-layout-request' }, '*');
}
