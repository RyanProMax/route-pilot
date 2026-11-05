// The fallback never displays cached measurements. Return to fresh status on reconnect.
window.addEventListener('online', () => window.location.replace('/'), { once: true });
